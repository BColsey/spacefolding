import type { CodeReference, CodeSymbol, ContextChunk, EmbeddingProvider, RerankerProvider, StructuralQuery } from '../types/index.js';
import type { SQLiteRepository } from '../storage/repository.js';
import type { RetrievalStrategy } from './query-planner.js';
import { parseStructuralQuery } from './query-planner.js';
import { normalizeSymbolName, splitIdentifier } from '../providers/structural-indexer.js';

export interface RetrievalResult {
  chunkId: string;
  score: number;
  sources: RetrievalSource[];
  sourceScores?: {
    structural: number;
    vector: number;
    fts: number;
    graph: number;
    dependency: number;
    final: number;
  };
  reasons: string[];
}

export type RetrievalSource = 'structural' | 'vector' | 'fts' | 'graph' | 'dependency';

export interface RetrievalOptions {
  topK?: number;
  returnLimit?: number;
  maxHops?: number;
  strategy?: RetrievalStrategy;
  mode?: RetrievalMode;
}

export type RetrievalMode = 'focused' | 'broad' | 'exhaustive';

const RRF_K = 60; // Reciprocal Rank Fusion constant

/** Merge multiple ranked lists using Reciprocal Rank Fusion */
export function reciprocalRankFusion(
  resultSets: { chunkId: string; score: number }[][],
  sources: string[]
): Map<string, { fusedScore: number; sources: Set<string> }> {
  const scores = new Map<string, { fusedScore: number; sources: Set<string> }>();

  for (let i = 0; i < resultSets.length; i++) {
    const results = resultSets[i];
    const source = sources[i] ?? 'unknown';

    for (let rank = 0; rank < results.length; rank++) {
      const { chunkId } = results[rank];
      const rrfScore = 1 / (RRF_K + rank + 1);
      const existing = scores.get(chunkId);
      if (existing) {
        existing.fusedScore += rrfScore;
        existing.sources.add(source);
      } else {
        scores.set(chunkId, { fusedScore: rrfScore, sources: new Set([source]) });
      }
    }
  }

  return scores;
}

/** Maximum candidates to send to the reranker (avoids unnecessary work) */
const RERANKER_MAX_CANDIDATES = 20;

export class HybridRetriever {
  private reranker: RerankerProvider | null;
  private vectorReliable: boolean;

  constructor(
    private storage: SQLiteRepository,
    private embeddingProvider: EmbeddingProvider,
    reranker?: RerankerProvider
  ) {
    this.reranker = reranker ?? null;
    this.vectorReliable = embeddingProvider.constructor?.name !== 'DeterministicEmbeddingProvider';
  }

  async retrieve(query: string, options: RetrievalOptions = {}): Promise<RetrievalResult[]> {
    const { topK = 50, maxHops = 0, strategy = 'hybrid' } = options;
    const fused = new Map<string, FusedCandidate>();
    const structuralQuery = parseStructuralQuery(query);
    const useStructural = strategy === 'structural';
    const useVector = strategy === 'hybrid' || strategy === 'vector' || strategy === 'structural';
    const useFts = strategy === 'hybrid' || strategy === 'text' || strategy === 'structural';
    const useGraph = strategy === 'graph' || ((strategy === 'hybrid') && maxHops > 0);

    if (strategy === 'structural' && !this.vectorReliable) {
      return this.retrieveDeterministicStructural(query, topK);
    }

    const weights = getFusionWeights(strategy, this.vectorReliable);

    // Structural symbol/path/reference search
    if (useStructural) {
      const structuralResults = this.storage.searchByStructure(structuralQuery, Math.max(topK, 50));
      addSource(
        fused,
        'structural',
        structuralResults.map((result) => ({
          chunkId: result.chunkId,
          score: result.structuralScore,
          reasons: result.reasons,
        })),
        weights.structural
      );
      addSource(
        fused,
        'dependency',
        structuralResults
          .filter((result) => result.dependencyBoost > 0)
          .map((result) => ({
            chunkId: result.chunkId,
            score: result.dependencyBoost,
            reasons: result.reasons.filter((reason) => reason.includes('reference')),
          })),
        weights.dependency
      );
    }

    // Vector search
    if (useVector) {
      const queryEmbedding = await this.embeddingProvider.embed(query);
      if (queryEmbedding.length > 0) {
        const vectorResults = this.storage.searchByVector(queryEmbedding, Math.max(topK, 50));
        addSource(
          fused,
          'vector',
          vectorResults.map((result) => ({ ...result, reasons: ['vector similarity match'] })),
          weights.vector
        );
      }
    }

    // Full-text search
    if (useFts) {
      const lexicalResults = typeof this.storage.searchByLexical === 'function'
        ? this.storage.searchByLexical(query, Math.max(topK, 50))
        : [];
      const ftsResults = strategy === 'structural' && !this.vectorReliable
        ? lexicalResults
        : mergeRawResults([
            this.storage.searchByText(query, Math.max(topK, 50)),
            lexicalResults,
          ]);
      addSource(
        fused,
        'fts',
        ftsResults.map((result) => ({ ...result, reasons: ['keyword match (FTS5/BM25)'] })),
        weights.fts
      );
    }

    // Graph traversal from seed results
    if (useGraph && maxHops > 0 && fused.size > 0) {
      const seedIds = [...fused.entries()]
        .sort((a, b) => b[1].fusedScore - a[1].fusedScore)
        .slice(0, 10)
        .map(([chunkId]) => chunkId);
      const expanded = this.multiHopExpand(seedIds, maxHops, topK);
      addSource(
        fused,
        'graph',
        expanded.map((result) => ({ ...result, reasons: ['dependency graph traversal'] })),
        weights.graph
      );
    }

    // Pure graph strategy without seeds — use all chunks
    if (strategy === 'graph' && maxHops > 0 && fused.size === 0) {
      const allChunks = this.storage.getAllChunks();
      if (allChunks.length > 0) {
        // For pure graph, start from recently routed chunks
        const recentChunks = allChunks.slice(-10);
        const expanded = this.multiHopExpand(
          recentChunks.map((c) => c.id),
          maxHops,
          topK
        );
        addSource(
          fused,
          'graph',
          expanded.map((result) => ({ ...result, reasons: ['dependency graph traversal'] })),
          weights.graph || 1
        );
      }
    }

    if (fused.size === 0) return [];

    // Sort by fused score and return
    const sorted = [...fused.entries()]
      .sort((a, b) => b[1].fusedScore - a[1].fusedScore)
      .slice(0, topK);

    // Rerank top candidates by keyword overlap if a reranker is available
    let reranked = sorted;
    if (this.reranker && sorted.length > 0) {
      const candidates = sorted.slice(0, RERANKER_MAX_CANDIDATES);
      const documents = candidates.map(([chunkId]) => {
        const chunk = this.storage.getChunk(chunkId);
        return chunk ? `${chunk.path ?? ''}\n${chunk.text}` : '';
      });

      try {
        const rerankResults = await this.reranker.rerank(query, documents);

        // Build a reranker score lookup and re-sort candidates
        const rerankScoreMap = new Map<number, number>();
        for (const r of rerankResults) {
          rerankScoreMap.set(r.index, r.score);
        }

        // Re-sort candidates by combined score (fused + small reranker boost)
        const rerankedCandidates = candidates.map(([chunkId, data], idx) => {
          const rerankerScore = rerankScoreMap.get(idx) ?? 0;
          const exactStructuralBoost = data.reasons.some((reason) =>
            reason.startsWith('symbol exact match') || reason.startsWith('path exact match')
          ) ? 1.0 : 0;
          return { chunkId, data, combinedScore: data.fusedScore + exactStructuralBoost + rerankerScore * 0.4 };
        });
        rerankedCandidates.sort((a, b) => b.combinedScore - a.combinedScore);

        reranked = [
          ...rerankedCandidates.map(({ chunkId, data }) => [chunkId, data] as [string, typeof data]),
          ...sorted.slice(candidates.length),
        ];
      } catch {
        // Reranker failure is non-fatal — fall back to RRF ordering
      }
    }

    // Build result objects with reasons
    return reranked.map(([chunkId, data]) => {
      const reasons: string[] = [];
      const sources = [...data.sources] as RetrievalSource[];

      reasons.push(...data.reasons);
      if (data.sources.has('dependency') && !data.reasons.some((reason) => reason.includes('reference'))) {
        reasons.push('direct dependency/reference boost');
      }

      const sourceScores = {
        structural: data.sourceScores.structural ?? 0,
        vector: data.sourceScores.vector ?? 0,
        fts: data.sourceScores.fts ?? 0,
        graph: data.sourceScores.graph ?? 0,
        dependency: data.sourceScores.dependency ?? 0,
        final: data.fusedScore,
      };
      reasons.push(
        `scores structural=${sourceScores.structural.toFixed(3)} vector=${sourceScores.vector.toFixed(3)} fts=${sourceScores.fts.toFixed(3)} dependency=${sourceScores.dependency.toFixed(3)} graph=${sourceScores.graph.toFixed(3)} final=${sourceScores.final.toFixed(3)}`
      );

      return { chunkId, score: data.fusedScore, sources, sourceScores, reasons };
    });
  }

  private multiHopExpand(
    seedIds: string[],
    maxHops: number,
    maxChunks: number
  ): { chunkId: string; score: number }[] {
    const visited = new Set<string>(seedIds);
    let frontier = seedIds;
    const results: { chunkId: string; score: number }[] = [];

    for (let hop = 0; hop < maxHops; hop++) {
      const nextFrontier: string[] = [];
      for (const id of frontier) {
        const deps = this.storage.getDependencies(id);
        for (const dep of deps) {
          const other = dep.fromId === id ? dep.toId : dep.fromId;
          if (!visited.has(other) && visited.size + nextFrontier.length < maxChunks) {
            nextFrontier.push(other);
            visited.add(other);
            results.push({ chunkId: other, score: 1 / (hop + 1) });
          }
        }
      }
      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }

    return results;
  }

  private retrieveDeterministicStructural(query: string, topK: number): RetrievalResult[] {
    const structuralQuery = parseStructuralQuery(query);
    const lowercaseExactCue = /\b(find|where|locate|show|contains|defined|grep)\b/i.test(query);
    const strongIdentifiers = new Set(
      structuralQuery.identifiers
        .filter((identifier) =>
          /[a-z0-9][A-Z]/.test(identifier) ||
          identifier.includes('_') ||
          /^[A-Z]{2,}$/.test(identifier) ||
          /^[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*$/.test(identifier) ||
          (lowercaseExactCue && /^[a-z][a-z0-9_$]{4,}$/.test(identifier))
        )
        .map((identifier) => identifier.toLowerCase().replace(/[^a-z0-9_$]/g, ''))
    );
    const lexicalResults = typeof this.storage.searchByLexical === 'function'
      ? this.storage.searchByLexical(query, Math.max(topK, 50))
      : this.storage.searchByText(query, Math.max(topK, 50));
    const structuralResults = this.storage.searchByStructure(structuralQuery, Math.max(topK, 50));
    const sparseTerms = buildSparseStructuralTerms(query, structuralQuery);
    const pathIntentTerms = buildPathIntentTerms(sparseTerms);
    const candidates = new Map<string, FusedCandidate>();

    for (const result of lexicalResults) {
      const lexicalScore = scaleDeterministicLexicalScore(result.score);
      if (lexicalScore <= 0) continue;
      candidates.set(result.chunkId, {
        fusedScore: lexicalScore,
        sources: new Set<RetrievalSource>(['fts']),
        sourceScores: { fts: lexicalScore },
        reasons: ['lexical keyword/path match'],
      });
    }

    for (const result of structuralResults) {
      const exactSymbol = result.reasons.some((reason) => {
        if (!reason.startsWith('symbol exact match: ')) return false;
        const symbolName = reason.slice('symbol exact match: '.length).toLowerCase().replace(/[^a-z0-9_$]/g, '');
        return strongIdentifiers.has(symbolName);
      });
      const exactPath = structuralQuery.pathFragments.length > 0 && result.reasons.some((reason) =>
        reason.startsWith('path exact match')
      );
      const boost = exactSymbol
        ? 12 + result.structuralScore
        : exactPath
          ? 10 + result.structuralScore
          : 0;
      if (boost <= 0) continue;
      const existing = candidates.get(result.chunkId) ?? {
        fusedScore: 0,
        sources: new Set<RetrievalSource>(),
        sourceScores: {},
        reasons: [],
      };
      existing.fusedScore += boost;
      existing.sources.add('structural');
      existing.sourceScores.structural = (existing.sourceScores.structural ?? 0) + boost;
      for (const reason of result.reasons) {
        if (!existing.reasons.includes(reason) && existing.reasons.length < 8) existing.reasons.push(reason);
      }
      candidates.set(result.chunkId, existing);
    }

    if (sparseTerms.length > 0 || structuralQuery.tokens.length > 0 || structuralQuery.identifierParts.length > 0) {
      for (const chunk of this.storage.getAllChunks()) {
        if (chunk.metadata?.split) continue;
        const sparseScore = sparseTerms.length > 0 ? scoreSparseStructuralFields(
          chunk,
          sparseTerms,
          this.storage.getCodeSymbols(chunk.id),
          this.storage.getCodeReferences(chunk.id)
        ) : { score: 0, reasons: [] };
        const pathIntent = scorePathIntent(chunk, structuralQuery, pathIntentTerms);
        const combinedScore = sparseScore.score + pathIntent.score;
        if (combinedScore <= 0) continue;
        const existing = candidates.get(chunk.id) ?? {
          fusedScore: 0,
          sources: new Set<RetrievalSource>(),
          sourceScores: {},
          reasons: [],
        };
        existing.fusedScore += combinedScore;
        existing.sources.add('structural');
        existing.sourceScores.structural = (existing.sourceScores.structural ?? 0) + combinedScore;
        for (const reason of [...pathIntent.reasons, ...sparseScore.reasons]) {
          if (!existing.reasons.includes(reason) && existing.reasons.length < 8) existing.reasons.push(reason);
        }
        candidates.set(chunk.id, existing);
      }
    }

    return [...candidates.entries()]
      .sort((a, b) => b[1].fusedScore - a[1].fusedScore)
      .slice(0, topK)
      .map(([chunkId, data]) => {
        const sourceScores = {
          structural: data.sourceScores.structural ?? 0,
          vector: 0,
          fts: data.sourceScores.fts ?? 0,
          graph: 0,
          dependency: data.sourceScores.dependency ?? 0,
          final: data.fusedScore,
        };
        return {
          chunkId,
          score: data.fusedScore,
          sources: [...data.sources],
          sourceScores,
          reasons: [
            ...data.reasons,
            `scores structural=${sourceScores.structural.toFixed(3)} vector=0.000 fts=${sourceScores.fts.toFixed(3)} dependency=${sourceScores.dependency.toFixed(3)} graph=0.000 final=${sourceScores.final.toFixed(3)}`,
          ],
        };
      });
  }
}

interface SourceResult {
  chunkId: string;
  score: number;
  reasons: string[];
}

interface FusedCandidate {
  fusedScore: number;
  sources: Set<RetrievalSource>;
  sourceScores: Partial<Record<RetrievalSource, number>>;
  reasons: string[];
}

function getFusionWeights(strategy: RetrievalStrategy, vectorReliable: boolean): Record<RetrievalSource, number> {
  if (strategy === 'structural') {
    return vectorReliable
      ? { structural: 0.58, vector: 0.24, fts: 0.15, dependency: 0.03, graph: 0 }
      : { structural: 0.09, vector: 0, fts: 0.88, dependency: 0.03, graph: 0 };
  }
  if (strategy === 'vector') {
    return { structural: 0, vector: 1, fts: 0, dependency: 0, graph: 0 };
  }
  if (strategy === 'text') {
    return { structural: 0, vector: 0, fts: 1, dependency: 0, graph: 0 };
  }
  if (strategy === 'graph') {
    return { structural: 0, vector: 0, fts: 0, dependency: 0, graph: 1 };
  }
  return { structural: 0, vector: 0.55, fts: 0.4, dependency: 0, graph: 0.05 };
}

function addSource(
  fused: Map<string, FusedCandidate>,
  source: RetrievalSource,
  results: SourceResult[],
  weight: number
): void {
  if (weight <= 0 || results.length === 0) return;
  const normalized = normalizeSourceResults(results);
  for (const result of normalized) {
    const contribution = result.normalizedScore * weight;
    if (contribution <= 0) continue;
    const existing = fused.get(result.chunkId) ?? {
      fusedScore: 0,
      sources: new Set<RetrievalSource>(),
      sourceScores: {},
      reasons: [],
    };
    existing.fusedScore += contribution;
    existing.sources.add(source);
    existing.sourceScores[source] = (existing.sourceScores[source] ?? 0) + contribution;
    for (const reason of result.reasons) {
      if (reason && !existing.reasons.includes(reason) && existing.reasons.length < 8) {
        existing.reasons.push(reason);
      }
    }
    fused.set(result.chunkId, existing);
  }
}

function normalizeSourceResults(results: SourceResult[]): Array<SourceResult & { normalizedScore: number }> {
  const sorted = [...results]
    .filter((result) => Number.isFinite(result.score))
    .sort((a, b) => b.score - a.score);
  if (sorted.length === 0) return [];

  const max = sorted[0].score;
  const min = sorted[sorted.length - 1].score;
  return sorted.map((result, index) => {
    const scoreRange = max - min;
    const normalizedScore = scoreRange > 1e-9
      ? (result.score - min) / scoreRange
      : 1;
    return {
      ...result,
      normalizedScore: Math.max(0, Math.min(1, normalizedScore)),
    };
  });
}

function scaleDeterministicLexicalScore(score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  return Math.min(8, Math.log1p(score) * 1.8);
}

interface SparseStructuralTerm {
  term: string;
  weight: number;
  origin: string;
}

const SPARSE_STOP_WORDS = new Set([
  'add', 'new', 'fix', 'how', 'why', 'what', 'where', 'when', 'does', 'using',
  'uses', 'use', 'support', 'supports', 'should', 'currently', 'actually',
  'properly', 'different', 'causing', 'flow', 'logic', 'large', 'files',
]);

const PATH_INTENT_STOP_WORDS = new Set([
  ...SPARSE_STOP_WORDS,
  'context',
  'count',
  'file',
  'files',
  'information',
  'show',
  'statistics',
  'total',
  'type',
  'types',
]);

const TERM_EXPANSIONS: Record<string, Array<[string, number]>> = {
  scoring: [['score', 1.2], ['scorer', 1.4], ['weight', 0.9], ['factor', 0.7]],
  score: [['scorer', 1.1], ['scoring', 0.8]],
  engine: [['scorer', 0.5], ['router', 0.4]],
  weight: [['weights', 0.8], ['scorer', 0.6], ['routingweights', 0.8]],
  weights: [['weight', 1.0], ['scorer', 0.6], ['routingweights', 0.8]],
  factor: [['factors', 0.8], ['scorer', 0.5]],
  factors: [['factor', 1.0], ['scorer', 0.5]],

  route: [['router', 1.2], ['routing', 0.8], ['hot', 0.4], ['warm', 0.4], ['cold', 0.4]],
  routed: [['route', 1.2], ['router', 1.4], ['routing', 1.0]],
  routing: [['route', 1.0], ['router', 1.3], ['hot', 0.5], ['warm', 0.5], ['cold', 0.5]],
  hot: [['router', 0.7], ['scorer', 0.4], ['routing', 0.5]],
  warm: [['router', 0.7], ['routing', 0.5]],
  cold: [['router', 0.7], ['scorer', 0.4], ['routing', 0.5]],
  constraint: [['router', 0.8], ['scorer', 0.7], ['constraint', 1.0]],

  chunk: [['chunks', 0.8], ['chunker', 0.9], ['ingester', 0.5], ['contextchunk', 0.5]],
  chunks: [['chunk', 1.0], ['chunker', 0.9], ['ingester', 0.5], ['contextchunk', 0.5]],
  chunking: [['chunk', 1.2], ['chunker', 1.4], ['split', 1.1], ['ingester', 0.9]],
  splitter: [['split', 1.1], ['chunker', 1.2], ['ingester', 0.7]],
  splits: [['split', 1.0], ['chunker', 1.0]],
  split: [['chunker', 0.8], ['ingester', 0.6], ['maybesplit', 0.9]],
  ingest: [['ingester', 1.0], ['ingestfile', 1.0], ['orchestrator', 0.8]],
  ingested: [['ingest', 1.1], ['ingester', 0.9], ['ingestfile', 0.9]],
  ingestion: [['ingest', 1.1], ['ingester', 0.9], ['orchestrator', 0.7]],
  reingestion: [['ingest', 1.1], ['ingester', 0.9], ['watcher', 1.2], ['filewatcher', 1.2]],
  reingest: [['ingest', 1.1], ['ingester', 0.9], ['watcher', 1.2], ['filewatcher', 1.2]],
  change: [['watcher', 1.0], ['filewatcher', 1.0], ['chokidar', 0.8]],
  changed: [['change', 1.0], ['watcher', 1.1], ['filewatcher', 1.1], ['chokidar', 0.8]],
  changing: [['change', 1.0], ['watcher', 1.0], ['filewatcher', 1.0], ['chokidar', 0.8]],
  modified: [['change', 0.9], ['watcher', 1.1], ['filewatcher', 1.1], ['chokidar', 0.8]],
  modification: [['change', 0.9], ['watcher', 1.0], ['filewatcher', 1.0], ['chokidar', 0.8]],
  watch: [['watcher', 1.2], ['filewatcher', 1.2], ['chokidar', 1.0]],
  watcher: [['filewatcher', 1.0], ['chokidar', 0.8]],

  embedding: [['embed', 1.0], ['embeddings', 0.8], ['embeddingprovider', 1.0], ['provider', 0.5]],
  embeddings: [['embedding', 1.0], ['embed', 0.9], ['embeddingprovider', 1.0], ['provider', 0.5]],
  provider: [['providers', 0.7], ['embeddingprovider', 0.5], ['compressionprovider', 0.5]],
  providers: [['provider', 1.0], ['embeddingprovider', 0.5], ['compressionprovider', 0.5]],
  openai: [['embedding', 0.5], ['provider', 0.5]],

  mcp: [['server', 0.8], ['tool', 0.8], ['calltoolrequestschema', 0.8]],
  tool: [['mcp', 0.7], ['server', 0.5], ['calltoolrequestschema', 0.7]],
  tools: [['tool', 1.0], ['mcp', 0.7], ['server', 0.5]],
  delete: [['deletechunk', 1.0], ['deletechunks', 1.0], ['remove', 0.8], ['repository', 0.7], ['storage', 0.5]],
  deleting: [['delete', 1.1], ['deletechunk', 1.0], ['remove', 0.8], ['repository', 0.7]],
  deletion: [['delete', 1.1], ['deletechunk', 1.0], ['remove', 0.8], ['repository', 0.7]],
  remove: [['delete', 0.8], ['repository', 0.5]],

  schema: [['migration', 0.9], ['migrations', 0.9], ['repository', 0.7], ['currentversion', 0.8]],
  migrations: [['migration', 1.0], ['schema', 1.0], ['currentversion', 0.9], ['repository', 0.6]],
  migration: [['migrations', 0.8], ['schema', 0.8], ['currentversion', 0.8]],
  database: [['storage', 1.0], ['repository', 1.1], ['schema', 0.8], ['db', 0.5]],
  stored: [['store', 1.1], ['storage', 1.0], ['repository', 0.9]],
  store: [['stored', 0.8], ['storage', 0.8], ['repository', 0.7]],
  queried: [['query', 1.0], ['get', 0.9], ['search', 0.7], ['repository', 0.7]],
  querieds: [['query', 1.0]],

  dependency: [['dependencies', 0.9], ['dependencylink', 1.1], ['repository', 0.8], ['graph', 0.7]],
  dependencies: [['dependency', 1.0], ['dependencylink', 1.1], ['repository', 0.8], ['graph', 0.7]],
  links: [['link', 1.0], ['dependencylink', 0.9], ['dependency', 0.7]],
  link: [['links', 0.8], ['dependencylink', 0.8]],
  graph: [['dependency', 0.7], ['dependencylink', 0.7]],

  hybrid: [['hybridretriever', 1.2], ['retriever', 1.0], ['retrieval', 0.7]],
  retriever: [['retrieve', 0.9], ['retrieval', 0.8], ['hybridretriever', 0.8]],
  retrieval: [['retrieve', 0.9], ['retriever', 1.0], ['hybridretriever', 0.7]],
  reranking: [['rerank', 1.2], ['reranker', 1.4], ['deterministicreranker', 1.0], ['rerankerprovider', 1.0]],
  rerank: [['reranker', 1.2], ['rerankerprovider', 0.9], ['deterministicreranker', 0.9]],
  cross: [['reranker', 0.7], ['rerankerprovider', 0.7]],
  encoder: [['reranker', 0.7], ['rerankerprovider', 0.7]],

  classifier: [['classify', 1.1], ['classification', 0.6], ['chunktype', 0.7]],
  classify: [['classifier', 1.2], ['chunktype', 0.7]],
  detect: [['classify', 0.8], ['classifier', 0.9]],
  detects: [['detect', 0.8], ['classifier', 0.9]],
  types: [['type', 1.0], ['chunktype', 0.9], ['contextchunk', 0.6]],

  environment: [['env', 1.1], ['process', 0.9], ['cli', 0.9], ['dbpath', 0.8], ['modelpath', 0.7], ['embeddingprovider', 0.8], ['compressionprovider', 0.8]],
  variables: [['env', 1.1], ['process', 0.9], ['cli', 0.8], ['dbpath', 0.8], ['modelpath', 0.7]],
  variable: [['env', 0.9], ['process', 0.7], ['cli', 0.6]],
  behavior: [['config', 0.5], ['env', 0.5]],

  sse: [['sseservertransport', 1.1], ['transport', 1.0], ['session', 0.9], ['sessionid', 0.9], ['transports', 0.8], ['server', 0.6]],
  transport: [['sse', 0.9], ['sseservertransport', 1.0], ['session', 0.8], ['transports', 0.8]],
  sessions: [['session', 1.0], ['sessionid', 0.9], ['transports', 0.7]],
  session: [['sessions', 0.8], ['sessionid', 0.9], ['transports', 0.7]],
  cleanup: [['close', 0.7], ['onclose', 0.9], ['delete', 0.4]],

  web: [['server', 0.8], ['html', 0.7], ['api', 0.5]],
  ui: [['web', 1.0], ['html', 0.8], ['server', 0.7], ['display', 0.5]],
  display: [['web', 0.8], ['html', 0.8], ['render', 0.6]],
  commands: [['command', 1.0], ['commander', 1.1], ['program', 0.9], ['cli', 0.9]],
  command: [['commands', 0.8], ['commander', 1.0], ['program', 0.8], ['cli', 0.8]],
  descriptions: [['description', 1.0], ['program', 0.4]],

  compression: [['compress', 1.1], ['compressionprovider', 0.9], ['summary', 0.6], ['provider', 0.4]],
  compress: [['compression', 0.9], ['compressionprovider', 0.8]],
  fallback: [['deterministic', 0.8], ['provider', 0.5]],
  deterministic: [['deterministiccompression', 0.7], ['deterministicembedding', 0.5], ['deterministicreranker', 0.5]],
  token: [['tokens', 0.8], ['estimate', 0.8], ['tokenestimator', 1.0]],
  tokens: [['token', 1.0], ['estimate', 0.8], ['tokenestimator', 1.0]],
  estimator: [['estimate', 1.0], ['tokenestimator', 1.2]],
  underestimating: [['estimate', 1.0], ['tokenestimator', 1.1], ['tokens', 0.6]],
  budget: [['fillbudget', 1.3], ['budgetresult', 0.9], ['retrievalresult', 0.8], ['retriever', 0.7]],
  controller: [['budget', 0.8], ['fillbudget', 0.7], ['router', 0.4]],
  overflow: [['budget', 0.8], ['fillbudget', 0.7], ['retrievalresult', 0.5]],
  sibling: [['collapsesiblings', 1.0], ['parentid', 0.6], ['budget', 0.5]],
  collapse: [['collapsesiblings', 1.0], ['parentid', 0.6], ['budget', 0.5]],
  python: [['def', 0.6], ['class', 0.4], ['chunker', 0.6]],
  export: [['exportdata', 0.8], ['dependencylink', 0.5]],
  import: [['exportdata', 0.6], ['dependencylink', 0.5]],
};

const PHRASE_EXPANSIONS: Array<[RegExp, Array<[string, number]>]> = [
  [/\bembedding providers?\b/i, [['embeddingprovider', 1.5], ['embedbatch', 1.1], ['types', 0.9]]],
  [/\bfull[-\s]?text\b/i, [['fts', 1.1], ['searchbytext', 0.9], ['searchbylexical', 0.8]]],
  [/\breranking\s+step\b/i, [['rerankerprovider', 1.6], ['reranker', 1.4], ['types', 1.0]]],
  [/\bcross[-\s]?encoder\b/i, [['reranker', 1.4], ['rerankerprovider', 1.6], ['deterministicreranker', 0.9], ['types', 1.0]]],
  [/\benvironment variables?\b/i, [['env', 1.4], ['process', 1.0], ['cli', 1.0], ['dbpath', 0.9], ['modelpath', 0.8]]],
  [/\bmcp tools?\b/i, [['mcp', 1.2], ['server', 1.0], ['calltoolrequestschema', 0.9]]],
  [/\bbatch\s+delet(?:e|es|ed|ing|ion)\b/i, [['repository', 1.3], ['storage', 1.2], ['deletechunks', 1.1], ['deletechunk', 1.1], ['contextfilter', 2.0]]],
  [/\b(?:source|path)\s+(?:or|and)\s+(?:source|path)\s+patterns?\b/i, [['contextfilter', 3.2], ['repository', 1.2], ['storage', 1.0], ['querychunks', 0.9]]],
  [/\b(?:authentication|auth|login)\b.*\b(?:401|unauthorized|errors?|bug)\b|\b(?:401|unauthorized|errors?|bug)\b.*\b(?:authentication|auth|login)\b/i, [['scorer', 1.3], ['router', 1.3], ['routing', 1.0]]],
  [/\blogin\s+flow\b/i, [['router', 1.2], ['scorer', 1.0]]],
  [/\bdependency graph\b/i, [['dependencylink', 1.2], ['repository', 0.9], ['exportdata', 0.7]]],
  [/\bweb ui\b/i, [['web', 1.2], ['server', 1.0], ['html', 0.9]]],
  [/\bcli commands?\b/i, [['cli', 1.2], ['commander', 1.1], ['program', 1.0]]],
  [/\btoken estimator\b/i, [['tokenestimator', 1.3], ['estimate', 1.0]]],
  [/\bbudget controller\b/i, [['fillbudget', 1.4], ['budgetresult', 1.0], ['retrievalresult', 0.9], ['retriever', 0.8]]],
  [/\bre[-\s]?ingest(?:ion|ed|s)?\b/i, [['ingest', 1.2], ['ingestfile', 1.1], ['watcher', 1.2], ['filewatcher', 1.2]]],
  [/\bincremental\s+file\s+re[-\s]?ingestion\b/i, [['filewatcher', 1.5], ['watcher', 1.5], ['chokidar', 1.1], ['scheduleingest', 1.1]]],
  [/\bfiles?\s+(?:is\s+|are\s+)?(?:modified|changed)|\b(?:modified|changed)\s+files?\b/i, [['filewatcher', 1.5], ['watcher', 1.5], ['chokidar', 1.1], ['scheduleingest', 1.0]]],
];

function buildSparseStructuralTerms(query: string, structuralQuery: StructuralQuery): SparseStructuralTerm[] {
  const terms = new Map<string, SparseStructuralTerm>();
  const add = (value: string, weight: number, origin: string) => {
    const term = normalizeSymbolName(value);
    if (term.length <= 1 || SPARSE_STOP_WORDS.has(term)) return;
    const existing = terms.get(term);
    if (!existing || existing.weight < weight) {
      terms.set(term, { term, weight, origin });
    }
  };

  for (const term of [...structuralQuery.tokens, ...structuralQuery.identifierParts]) {
    add(term, 0.55, 'query');
    const stem = stemSparseTerm(term);
    if (stem !== term) add(stem, 0.45, 'stem');
  }
  for (const identifier of structuralQuery.identifiers) {
    add(identifier, 0.8, 'identifier');
    for (const part of splitIdentifier(identifier)) add(part, 0.55, 'identifier');
  }

  for (const [pattern, expanded] of PHRASE_EXPANSIONS) {
    if (!pattern.test(query)) continue;
    for (const [term, weight] of expanded) add(term, weight, 'phrase');
  }

  const snapshot = [...terms.values()];
  for (const { term, weight } of snapshot) {
    const expansions = TERM_EXPANSIONS[term] ?? TERM_EXPANSIONS[stemSparseTerm(term)] ?? [];
    for (const [expanded, expansionWeight] of expansions) {
      add(expanded, Math.min(1.5, weight * expansionWeight), `expand:${term}`);
    }
  }

  return [...terms.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 32);
}

function buildPathIntentTerms(sparseTerms: SparseStructuralTerm[]): string[] {
  return [...new Set(sparseTerms
    .filter((term) => term.weight >= 0.8 && (term.origin === 'phrase' || term.origin.startsWith('expand:')))
    .map((term) => term.term)
    .filter((term) => term.length > 2 && !PATH_INTENT_STOP_WORDS.has(term)))];
}

function stemSparseTerm(value: string): string {
  const term = normalizeSymbolName(value);
  if (term.endsWith('ies') && term.length > 4) return `${term.slice(0, -3)}y`;
  if (term.endsWith('ing') && term.length > 5) return term.slice(0, -3);
  if (term.endsWith('ed') && term.length > 4) return term.slice(0, -2);
  if (term.endsWith('es') && term.length > 4) return term.slice(0, -2);
  if (term.endsWith('s') && term.length > 4) return term.slice(0, -1);
  return term;
}

function scoreSparseStructuralFields(
  chunk: ContextChunk,
  terms: SparseStructuralTerm[],
  symbols: CodeSymbol[],
  references: CodeReference[]
): { score: number; reasons: string[] } {
  const path = chunk.path ?? '';
  const normalizedPath = normalizeSymbolName(path);
  const pathParts = new Set(tokenizeStructuralField(path));
  const basename = path.split('/').pop() ?? path;
  const basenameStem = basename.replace(/\.[^.]+$/, '');
  const basenameNormalized = normalizeSymbolName(basenameStem);
  const basenameParts = new Set(tokenizeStructuralField(basenameStem));
  const symbolFields = symbols.map((symbol) => ({
    name: symbol.name,
    normalized: normalizeSymbolName(symbol.name),
    kind: symbol.kind,
    parts: new Set(splitIdentifier(symbol.name).map(normalizeSymbolName)),
    signature: normalizeSymbolName(symbol.signature ?? ''),
    exported: symbol.isExported,
  }));
  const referenceFields = references.map((reference) => ({
    target: reference.target,
    normalized: normalizeSymbolName(reference.target),
    parts: new Set(splitIdentifier(reference.target).map(normalizeSymbolName)),
  }));

  let score = 0;
  const reasons: string[] = [];
  for (const term of terms) {
    const field = scoreSparseTerm(term, {
      normalizedPath,
      pathParts,
      basenameNormalized,
      basenameParts,
      symbolFields,
      referenceFields,
    });
    if (field.score <= 0) continue;
    const capMultiplier = field.reason.startsWith('sparse contract exact')
      ? 3.2
      : field.reason.startsWith('sparse symbol exact')
        ? 2.4
        : 1.6;
    score += Math.min(field.score, capMultiplier * term.weight);
    if (reasons.length < 5) reasons.push(field.reason);
  }

  const hasExactContract = reasons.some((reason) => reason.startsWith('sparse contract exact'));
  return { score: Math.min(hasExactContract ? 12 : 7, score), reasons };
}

function scorePathIntent(
  chunk: ContextChunk,
  structuralQuery: StructuralQuery,
  expandedTerms: string[] = []
): { score: number; reasons: string[] } {
  const path = chunk.path ?? '';
  if (!path) return { score: 0, reasons: [] };

  const pathParts = new Set(tokenizeStructuralField(path));
  const basename = path.split('/').pop() ?? path;
  const basenameParts = new Set(tokenizeStructuralField(basename.replace(/\.[^.]+$/, '')));
  const terms = [...new Set([
    ...structuralQuery.tokens,
    ...structuralQuery.identifierParts,
    ...structuralQuery.identifiers.flatMap(splitIdentifier),
    ...expandedTerms,
  ]
    .map(normalizeSymbolName)
    .filter((term) => term.length > 2 && !PATH_INTENT_STOP_WORDS.has(term)))];

  let score = 0;
  const reasons: string[] = [];
  for (const term of terms) {
    if (basenameParts.has(term)) {
      score += 5;
      if (reasons.length < 3) reasons.push(`path intent filename match: ${term}`);
    } else if (pathParts.has(term)) {
      score += 8;
      if (reasons.length < 3) reasons.push(`path intent segment match: ${term}`);
    }
  }

  return { score: Math.min(12, score), reasons };
}

function scoreSparseTerm(
  term: SparseStructuralTerm,
  fields: {
    normalizedPath: string;
    pathParts: Set<string>;
    basenameNormalized: string;
    basenameParts: Set<string>;
    symbolFields: Array<{ name: string; normalized: string; kind: CodeSymbol['kind']; parts: Set<string>; signature: string; exported: boolean }>;
    referenceFields: Array<{ target: string; normalized: string; parts: Set<string> }>;
  }
): { score: number; reason: string } {
  const value = term.term;
  const weight = term.weight;
  let bestScore = 0;
  let bestReason = '';

  const consider = (score: number, reason: string) => {
    if (score > bestScore) {
      bestScore = score;
      bestReason = reason;
    }
  };

  if (fields.basenameNormalized === value) consider(1.05 * weight, `sparse path exact: ${value}`);
  if (fields.basenameParts.has(value)) consider(0.8 * weight, `sparse filename token: ${value}`);
  if (fields.pathParts.has(value)) consider(0.42 * weight, `sparse path token: ${value}`);
  if (fields.basenameNormalized === 'index') {
    const matchingSegment = [...fields.pathParts].find((part) => part !== 'index' && isSingularPluralMatch(value, part));
    if (matchingSegment) consider(1.1 * weight, `sparse module index segment: ${matchingSegment}`);
  }
  if (value.length >= 4 && fields.normalizedPath.includes(value)) consider(0.18 * weight, `sparse path partial: ${value}`);

  for (const symbol of fields.symbolFields) {
    const exported = symbol.exported ? 1.1 : 1;
    const contract = symbol.kind === 'interface' || symbol.kind === 'type' ? 2.1 : 1;
    if (symbol.normalized === value) {
      const reason = contract > 1 ? `sparse contract exact: ${symbol.name}` : `sparse symbol exact: ${symbol.name}`;
      consider((contract > 1 ? 1.5 : 1.2) * weight * exported * contract, reason);
    }
    if (symbol.parts.has(value)) consider(0.62 * weight * exported, `sparse symbol token: ${symbol.name}`);
    if (value.length >= 4 && symbol.normalized.includes(value)) consider(0.38 * weight * exported, `sparse symbol partial: ${symbol.name}`);
    if (value.length >= 4 && symbol.signature.includes(value)) consider(0.22 * weight * exported, `sparse signature token: ${symbol.name}`);
  }

  for (const reference of fields.referenceFields) {
    if (reference.normalized === value) consider(0.42 * weight, `sparse reference exact: ${reference.target}`);
    if (reference.parts.has(value)) consider(0.24 * weight, `sparse reference token: ${reference.target}`);
    if (value.length >= 4 && reference.normalized.includes(value)) consider(0.16 * weight, `sparse reference partial: ${reference.target}`);
  }

  return { score: bestScore, reason: bestReason };
}

function tokenizeStructuralField(value: string): string[] {
  return value
    .split(/[/. _:-]+/)
    .flatMap((part) => splitIdentifier(part))
    .map(normalizeSymbolName)
    .filter((part) => part.length > 1);
}

function isSingularPluralMatch(term: string, fieldPart: string): boolean {
  if (term === fieldPart) return true;
  if (term.length <= 2 || fieldPart.length <= 2) return false;
  if (`${term}s` === fieldPart || `${fieldPart}s` === term) return true;
  if (term.endsWith('ies') && `${term.slice(0, -3)}y` === fieldPart) return true;
  if (fieldPart.endsWith('ies') && `${fieldPart.slice(0, -3)}y` === term) return true;
  return false;
}

function mergeRawResults(resultSets: Array<Array<{ chunkId: string; score: number }>>): { chunkId: string; score: number }[] {
  const merged = new Map<string, number>();
  for (const results of resultSets) {
    for (const result of results) {
      merged.set(result.chunkId, (merged.get(result.chunkId) ?? 0) + result.score);
    }
  }
  return [...merged.entries()]
    .map(([chunkId, score]) => ({ chunkId, score }))
    .sort((a, b) => b.score - a.score);
}
