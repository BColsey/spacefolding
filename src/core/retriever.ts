import type {
  CodeReference,
  CodeSymbol,
  ContextChunk,
  EmbeddingProvider,
  EmbeddingQuality,
  RerankerProvider,
  RetrievalMode,
  RetrievalStrategy,
  StructuralQuery,
  StructuralSearchResult,
} from '../types/index.js';
import type { SQLiteRepository } from '../storage/repository.js';
import { parseStructuralQuery } from './query-planner.js';
import { normalizeSymbolName, splitIdentifier } from '../providers/structural-indexer.js';

export type { RetrievalMode } from '../types/index.js';

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
export type RetrievalSourceScores = NonNullable<RetrievalResult['sourceScores']>;

export interface RetrievalOptions {
  topK?: number;
  returnLimit?: number;
  maxHops?: number;
  strategy?: RetrievalStrategy;
  mode?: RetrievalMode;
}

const SOURCE_SCORE_FIELDS: Array<keyof RetrievalSourceScores> = [
  'structural',
  'vector',
  'fts',
  'graph',
  'dependency',
  'final',
];

export function formatSourceScoreBreakdown(sourceScores: RetrievalSourceScores): string {
  return `scores ${SOURCE_SCORE_FIELDS
    .map((field) => `${field}=${sourceScores[field].toFixed(3)}`)
    .join(' ')}`;
}

/** Maximum candidates to send to the reranker (avoids unnecessary work) */
const RERANKER_MAX_CANDIDATES = 20;

/**
 * Single source of truth for embedding quality. Prefers the provider's declared
 * `quality` tier; falls back to a constructor-name check for older providers and
 * test mocks. Replaces the brittle `constructor.name` check that broke under
 * minification and disagreed with the env-var path in the query planner.
 */
function inferEmbeddingQuality(provider: EmbeddingProvider): EmbeddingQuality {
  if (provider.quality) return provider.quality;
  return provider.constructor?.name === 'DeterministicEmbeddingProvider'
    ? 'deterministic'
    : 'local';
}

export class HybridRetriever {
  private reranker: RerankerProvider | null;
  private vectorReliable: boolean;

  constructor(
    private storage: SQLiteRepository,
    private embeddingProvider: EmbeddingProvider,
    reranker?: RerankerProvider
  ) {
    this.reranker = reranker ?? null;
    this.vectorReliable = inferEmbeddingQuality(embeddingProvider) !== 'deterministic';
  }

  async retrieve(query: string, options: RetrievalOptions = {}): Promise<RetrievalResult[]> {
    const { topK = 50, strategy = 'hybrid' } = options;
    const maxHops = options.maxHops ?? (strategy === 'graph' ? 1 : 0);
    const fused = new Map<string, FusedCandidate>();
    const structuralQuery = parseStructuralQuery(query);
    const strongIdentifiers = buildStrongIdentifierSet(query, structuralQuery);
    const useStructural = strategy === 'structural';
    const useVector = strategy === 'hybrid' || strategy === 'vector' || strategy === 'structural';
    const useFts = strategy === 'hybrid' || strategy === 'text' || strategy === 'structural';
    const useGraph = strategy === 'graph' || ((strategy === 'hybrid') && maxHops > 0);
    const fallbackSourcesAvailable = useStructural || useFts;
    const retrievalWarnings: string[] = [];

    if (strategy === 'structural' && !this.vectorReliable) {
      return this.retrieveDeterministicStructural(query, topK);
    }

    const weights = getFusionWeights(strategy, this.vectorReliable);

    // Structural symbol/path/reference search
    if (useStructural) {
      try {
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
        applyStrongIdentifierStructuralBoost(fused, structuralResults, strongIdentifiers);
      } catch (err) {
        if (!useVector && !useFts) throw err;
        retrievalWarnings.push(`structural retrieval unavailable: ${errorMessage(err)}`);
      }
    }

    // Vector search
    if (useVector) {
      try {
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
      } catch (err) {
        if (!fallbackSourcesAvailable) throw err;
        retrievalWarnings.push(`vector retrieval unavailable: ${errorMessage(err)}`);
      }
    }

    // Full-text search
    if (useFts) {
      const textResults = searchTextSources(this.storage, query, Math.max(topK, 50), retrievalWarnings);
      if (textResults.failures > 0 && textResults.successes === 0 && !useStructural && !useVector) {
        throw textResults.firstError ?? new Error('text retrieval unavailable');
      }
      addSource(
        fused,
        'fts',
        textResults.results.map((result) => ({ ...result, reasons: ['keyword match (FTS5/BM25)'] })),
        weights.fts
      );
    }

    // Graph traversal from seed results
    if (useGraph && maxHops > 0 && fused.size > 0) {
      const seedIds = [...fused.entries()]
        .sort((a, b) => b[1].fusedScore - a[1].fusedScore)
        .slice(0, 10)
        .map(([chunkId]) => chunkId);
      try {
        const expanded = this.multiHopExpand(seedIds, maxHops, topK);
        addSource(
          fused,
          'graph',
          expanded.map((result) => ({ ...result, reasons: ['dependency graph traversal'] })),
          weights.graph
        );
      } catch (err) {
        if (strategy === 'graph') throw err;
        retrievalWarnings.push(`graph retrieval unavailable: ${errorMessage(err)}`);
      }
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
        const rerankScoreMap = new Map<number, { score: number; reason: string }>();
        for (const r of rerankResults) {
          if (Number.isFinite(r.index) && Number.isFinite(r.score)) {
            rerankScoreMap.set(r.index, { score: r.score, reason: r.reason });
          }
        }

        // Re-sort candidates by combined score (fused + small reranker boost)
        const rerankedCandidates = candidates.map(([chunkId, data], idx) => {
          const rerank = rerankScoreMap.get(idx);
          const rerankerScore = rerank?.score ?? 0;
          // Both boosts are rescaled to the RRF magnitude (data.fusedScore is a
          // sum of weight/(RRF_K+rank) terms, typically O(0.0x)). The reranker
          // score is normally in [0,1]; multiplying by ~3 top-rank contributions
          // lets a confident reranker move a chunk a few ranks. An exact
          // structural match adds ~2 top-rank contributions on top.
          const exactStructuralBoost = data.reasons.some((reason) =>
            reason.startsWith('symbol exact match') || reason.startsWith('path exact match')
          ) ? RRF_TOP_CONTRIBUTION * 2 : 0;
          const rerankReasons = [];
          if (rerank) rerankReasons.push(`reranker ${rerank.reason}: ${rerankerScore.toFixed(3)}`);
          if (exactStructuralBoost > 0) {
            rerankReasons.push(`rerank exact structural boost: ${exactStructuralBoost.toFixed(3)}`);
          }
          return {
            chunkId,
            data,
            combinedScore: data.fusedScore + exactStructuralBoost + rerankerScore * RRF_TOP_CONTRIBUTION * 3,
            rerankReasons,
          };
        });
        rerankedCandidates.sort((a, b) => b.combinedScore - a.combinedScore);

        reranked = [
          ...rerankedCandidates.map(({ chunkId, data, combinedScore, rerankReasons }) => {
            data.finalScore = combinedScore;
            data.rerankReasons = rerankReasons;
            return [chunkId, data] as [string, typeof data];
          }),
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
      reasons.push(...(data.rerankReasons ?? []));
      reasons.push(...retrievalWarnings);
      if (data.sources.has('dependency') && !data.reasons.some((reason) => reason.includes('reference'))) {
        reasons.push('direct dependency/reference boost');
      }

      const sourceScores = buildSourceScores(data);
      reasons.push(formatSourceScoreBreakdown(sourceScores));

      return { chunkId, score: sourceScores.final, sources, sourceScores, reasons };
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
          if (!visited.has(other) && results.length + nextFrontier.length < maxChunks) {
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
    const retrievalWarnings: string[] = [];
    const strongIdentifiers = buildStrongIdentifierSet(query, structuralQuery);
    const strongIdentifierCases = buildStrongIdentifierCaseSet(query, structuralQuery);
    let lexicalResults: { chunkId: string; score: number }[] = [];
    try {
      lexicalResults = typeof this.storage.searchByLexical === 'function'
        ? this.storage.searchByLexical(query, Math.max(topK, 50))
        : this.storage.searchByText(query, Math.max(topK, 50));
    } catch (err) {
      pushUniqueWarning(retrievalWarnings, `text retrieval unavailable: ${errorMessage(err)}`);
    }

    let structuralResults: StructuralSearchResult[] = [];
    try {
      structuralResults = this.storage.searchByStructure(structuralQuery, Math.max(topK, 50));
    } catch (err) {
      pushUniqueWarning(retrievalWarnings, `structural retrieval unavailable: ${errorMessage(err)}`);
    }
    const structuralData = createStructuralDataCache(this.storage, retrievalWarnings);
    const corpusStemIndex = buildCorpusStemIndex(structuralData.allSymbols());
    const sparseTerms = buildSparseStructuralTerms(structuralQuery, corpusStemIndex);
    const pathIntentTerms = buildPathIntentTerms(sparseTerms);
    const candidates = new Map<string, FusedCandidate>();
    const shouldScoreSparseFields = sparseTerms.length > 0 || strongIdentifiers.size > 0;

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
      const exactIdentifier = result.reasons.some((reason) =>
        isExactIdentifierSeedReason(reason, strongIdentifiers)
      );
      const exactPath = structuralQuery.pathFragments.length > 0 && result.reasons.some((reason) =>
        reason.startsWith('path exact match')
      );
      const boost = exactIdentifier
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

    if (shouldScoreSparseFields || structuralQuery.tokens.length > 0 || structuralQuery.identifierParts.length > 0) {
      for (const chunk of this.storage.getAllChunks()) {
        if (chunk.metadata?.split) continue;
        const symbols = shouldScoreSparseFields ? structuralData.symbolsFor(chunk.id) : [];
        const references = shouldScoreSparseFields ? structuralData.referencesFor(chunk.id) : [];
        const sparseScore = shouldScoreSparseFields ? scoreSparseStructuralFields(
          chunk,
          sparseTerms,
          symbols,
          references,
          strongIdentifiers,
          strongIdentifierCases
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
        const sourceScores = buildSourceScores(data);
        return {
          chunkId,
          score: sourceScores.final,
          sources: [...data.sources],
          sourceScores,
          reasons: [
            ...data.reasons,
            ...retrievalWarnings,
            formatSourceScoreBreakdown(sourceScores),
          ],
        };
      });
  }
}

interface StructuralDataCache {
  symbolsFor(chunkId: string): CodeSymbol[];
  referencesFor(chunkId: string): CodeReference[];
  allSymbols(): CodeSymbol[];
}

function createStructuralDataCache(
  storage: SQLiteRepository,
  warnings: string[]
): StructuralDataCache {
  const symbolCache = new Map<string, CodeSymbol[]>();
  const referenceCache = new Map<string, CodeReference[]>();
  let allSymbolsList: CodeSymbol[] = [];
  let symbolsBatched = false;
  let referencesBatched = false;
  let symbolBatchAttempted = false;
  let referenceBatchAttempted = false;
  let symbolLookupFailed = false;
  let referenceLookupFailed = false;

  const loadSymbolsBatch = () => {
    if (symbolBatchAttempted) return;
    symbolBatchAttempted = true;
    try {
      const symbols = typeof storage.getAllCodeSymbols === 'function'
        ? storage.getAllCodeSymbols()
        : null;
      if (symbols) {
        allSymbolsList = symbols;
        fillStructuralCache(symbolCache, symbols, (symbol) => symbol.chunkId);
        symbolsBatched = true;
      }
    } catch {
      symbolsBatched = false;
    }
  };

  const loadReferencesBatch = () => {
    if (referenceBatchAttempted) return;
    referenceBatchAttempted = true;
    try {
      const references = typeof storage.getAllCodeReferences === 'function'
        ? storage.getAllCodeReferences()
        : null;
      if (references) {
        fillStructuralCache(referenceCache, references, (reference) => reference.chunkId);
        referencesBatched = true;
      }
    } catch {
      referencesBatched = false;
    }
  };

  return {
    symbolsFor(chunkId: string): CodeSymbol[] {
      loadSymbolsBatch();
      if (symbolsBatched) return symbolCache.get(chunkId) ?? [];
      if (symbolCache.has(chunkId)) return symbolCache.get(chunkId) ?? [];
      if (symbolLookupFailed) return [];
      const symbols = safeCodeSymbols(storage, chunkId, warnings);
      symbolCache.set(chunkId, symbols);
      if (symbols.length === 0 && warnings.some((warning) => warning.startsWith('code symbol lookup unavailable'))) {
        symbolLookupFailed = true;
      }
      return symbols;
    },
    referencesFor(chunkId: string): CodeReference[] {
      loadReferencesBatch();
      if (referencesBatched) return referenceCache.get(chunkId) ?? [];
      if (referenceCache.has(chunkId)) return referenceCache.get(chunkId) ?? [];
      if (referenceLookupFailed) return [];
      const references = safeCodeReferences(storage, chunkId, warnings);
      referenceCache.set(chunkId, references);
      if (references.length === 0 && warnings.some((warning) => warning.startsWith('code reference lookup unavailable'))) {
        referenceLookupFailed = true;
      }
      return references;
    },
    allSymbols(): CodeSymbol[] {
      loadSymbolsBatch();
      return allSymbolsList;
    },
  };
}

function fillStructuralCache<T>(
  cache: Map<string, T[]>,
  items: T[],
  getChunkId: (item: T) => string | undefined
): void {
  for (const item of items) {
    const chunkId = getChunkId(item);
    if (!chunkId) continue;
    const existing = cache.get(chunkId);
    if (existing) {
      existing.push(item);
    } else {
      cache.set(chunkId, [item]);
    }
  }
}

function buildSourceScores(data: FusedCandidate): RetrievalSourceScores {
  return {
    structural: data.sourceScores.structural ?? 0,
    vector: data.sourceScores.vector ?? 0,
    fts: data.sourceScores.fts ?? 0,
    graph: data.sourceScores.graph ?? 0,
    dependency: data.sourceScores.dependency ?? 0,
    final: data.finalScore ?? data.fusedScore,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pushUniqueWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

function safeCodeSymbols(
  storage: SQLiteRepository,
  chunkId: string,
  warnings: string[]
): CodeSymbol[] {
  try {
    return storage.getCodeSymbols(chunkId);
  } catch (err) {
    pushUniqueWarning(warnings, `code symbol lookup unavailable: ${errorMessage(err)}`);
    return [];
  }
}

function safeCodeReferences(
  storage: SQLiteRepository,
  chunkId: string,
  warnings: string[]
): CodeReference[] {
  try {
    return storage.getCodeReferences(chunkId);
  } catch (err) {
    pushUniqueWarning(warnings, `code reference lookup unavailable: ${errorMessage(err)}`);
    return [];
  }
}

function searchTextSources(
  storage: SQLiteRepository,
  query: string,
  topK: number,
  warnings: string[]
): {
  results: { chunkId: string; score: number }[];
  successes: number;
  failures: number;
  firstError?: unknown;
} {
  const resultSets: Array<{ chunkId: string; score: number }[]> = [];
  let successes = 0;
  let failures = 0;
  let firstError: unknown;

  const run = (source: 'full-text' | 'lexical', search: () => { chunkId: string; score: number }[]) => {
    try {
      resultSets.push(search());
      successes++;
    } catch (err) {
      failures++;
      firstError ??= err;
      pushUniqueWarning(warnings, `${source} retrieval unavailable: ${errorMessage(err)}`);
    }
  };

  run('full-text', () => storage.searchByText(query, topK));
  if (typeof storage.searchByLexical === 'function') {
    run('lexical', () => storage.searchByLexical(query, topK));
  }

  return {
    results: mergeRawResults(resultSets),
    successes,
    failures,
    firstError,
  };
}

interface SourceResult {
  chunkId: string;
  score: number;
  reasons: string[];
}

interface FusedCandidate {
  fusedScore: number;
  finalScore?: number;
  sources: Set<RetrievalSource>;
  sourceScores: Partial<Record<RetrievalSource, number>>;
  reasons: string[];
  rerankReasons?: string[];
}

const STRONG_IDENTIFIER_STOP_WORDS = new Set([
  'contain',
  'contains',
  'defined',
  'definition',
  'file',
  'files',
  'find',
  'grep',
  'locate',
  'show',
  'where',
  'which',
]);

function buildStrongIdentifierSet(query: string, structuralQuery: StructuralQuery): Set<string> {
  return new Set(
    buildStrongIdentifierCandidates(query, structuralQuery)
      .map((identifier) => normalizeStrongIdentifier(identifier))
      .filter((identifier) => identifier.length > 0)
  );
}

function buildStrongIdentifierCaseSet(query: string, structuralQuery: StructuralQuery): Set<string> {
  return new Set(buildStrongIdentifierCandidates(query, structuralQuery));
}

function buildStrongIdentifierCandidates(query: string, structuralQuery: StructuralQuery): string[] {
  const lowercaseExactCue = /\b(find|where|locate|show|contains|defined|grep|which\s+file)\b/i.test(query);
  const explainSymbolCue = /\b(?:what\s+does|what\s+do|explain|describe|implementation|how\s+does|how\s+do)\b/i.test(query);
  const behaviorSubjectIdentifiers = new Set(
    [...query.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s+(?:is|are)\s+(?:returning|giving|producing)\s+(?:wrong|bad|incorrect|unexpected)\s+values?\b/gi)]
      .map((match) => match[1])
  );

  return structuralQuery.identifiers
    .filter((identifier) => !STRONG_IDENTIFIER_STOP_WORDS.has(identifier.toLowerCase()))
    .filter((identifier) =>
      /[a-z0-9][A-Z]/.test(identifier) ||
      identifier.includes('_') ||
      /^[A-Z]{2,}$/.test(identifier) ||
      /^[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*$/.test(identifier) ||
      (explainSymbolCue && /^[A-Z][A-Za-z0-9_$]{2,}$/.test(identifier)) ||
      (behaviorSubjectIdentifiers.has(identifier) && /^[a-z][a-z0-9_$]{2,}$/.test(identifier)) ||
      (lowercaseExactCue && /^[a-z][a-z0-9_$]{4,}$/.test(identifier)) ||
      (lowercaseExactCue && /[A-Z]/.test(identifier) && /^[A-Za-z][A-Za-z0-9_$]{4,}$/.test(identifier))
    );
}

function applyStrongIdentifierStructuralBoost(
  fused: Map<string, FusedCandidate>,
  structuralResults: StructuralSearchResult[],
  strongIdentifiers: Set<string>
): void {
  if (strongIdentifiers.size === 0 || structuralResults.length === 0) return;

  for (const result of structuralResults) {
    const symbolMatches = new Set<string>();
    const referenceMatches = new Set<string>();
    for (const reason of result.reasons) {
      const symbol = extractReasonValueFromPrefixes(reason, [
        'symbol exact match: ',
        'symbol strong exact match: ',
      ]);
      if (symbol && strongIdentifiers.has(normalizeStrongIdentifier(symbol))) {
        symbolMatches.add(symbol);
      }
      const reference = extractReasonValueFromPrefixes(reason, [
        'direct reference exact match: ',
        'direct reference strong exact match: ',
      ]);
      if (reference && strongIdentifiers.has(normalizeStrongIdentifier(reference))) {
        referenceMatches.add(reference);
      }
    }

    const candidate = fused.get(result.chunkId);
    if (!candidate) continue;

    // Rescaled to the RRF magnitude. The previous raw values (~1.25) were on the
    // old min-max scale and would dwarf RRF contributions (~0.016 at rank 1). An
    // exact symbol match is now worth ~3 top-rank RRF contributions plus a small
    // per-match increment; a direct reference match adds ~1 top-rank contribution.
    // This meaningfully promotes exact matches without overwhelming the agreement
    // signal of several sources independently ranking a chunk highly.
    const symbolBoost = symbolMatches.size > 0
      ? RRF_TOP_CONTRIBUTION * (3 + Math.min(1, symbolMatches.size * 0.3))
      : 0;
    const referenceBoost = referenceMatches.size > 0 ? RRF_TOP_CONTRIBUTION * 1 : 0;
    const exactIdentifierBoost = symbolBoost + referenceBoost;
    if (exactIdentifierBoost <= 0) continue;

    candidate.fusedScore += exactIdentifierBoost;
    candidate.sources.add('structural');
    candidate.sourceScores.structural = (candidate.sourceScores.structural ?? 0) + exactIdentifierBoost;
    if (candidate.reasons.length < 8) {
      const matched = [
        ...[...symbolMatches].map((name) => `symbol:${name}`),
        ...[...referenceMatches].map((name) => `reference:${name}`),
      ].slice(0, 2);
      candidate.reasons.push(`exact identifier boost: ${matched.join(', ')}`);
    }
  }
}

function extractReasonValue(reason: string, prefix: string): string | null {
  if (!reason.startsWith(prefix)) return null;
  const value = reason.slice(prefix.length).trim();
  return value.length > 0 ? value : null;
}

function extractReasonValueFromPrefixes(reason: string, prefixes: string[]): string | null {
  for (const prefix of prefixes) {
    const value = extractReasonValue(reason, prefix);
    if (value) return value;
  }
  return null;
}

function isExactIdentifierSeedReason(reason: string, strongIdentifiers: Set<string>): boolean {
  if (strongIdentifiers.size === 0) return false;
  const value = extractReasonValueFromPrefixes(reason, [
    'symbol exact match: ',
    'direct reference exact match: ',
  ]);
  return value !== null && strongIdentifiers.has(normalizeStrongIdentifier(value));
}

function normalizeStrongIdentifier(identifier: string): string {
  return identifier.toLowerCase().replace(/[^a-z0-9_$]/g, '');
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

/**
 * Reciprocal Rank Fusion constant. A chunk at 1-based rank `r` in a source
 * contributes `weight / (RRF_K + r)`. k=60 is the canonical default from
 * Cormack et al. (2009); it dampens the gap between top ranks without letting
 * any single source dominate.
 */
const RRF_K = 60;

/** Top-rank (rank 1) RRF contribution at unit weight: 1 / (RRF_K + 1). */
const RRF_TOP_CONTRIBUTION = 1 / (RRF_K + 1);

/**
 * Absolute relevance floor for vector (cosine) results. Cosine similarities
 * below this are treated as noise and dropped before ranking, so a source with
 * no genuinely-relevant hit contributes nothing and retrieval can return [].
 */
const VECTOR_RELEVANCE_FLOOR = 0.2;

/**
 * Reciprocal Rank Fusion. Replaces the previous weighted min-max sum, which was
 * not scale-free: a source whose raw scores happened to span a wider range
 * dominated regardless of agreement. RRF is rank-based — only the order of each
 * source's results matters — so heterogeneous score scales (cosine ~0..1, BM25
 * negative log-odds, structural integers) become commensurate.
 *
 * For each source the results are sorted by score descending; the chunk at
 * 1-based rank `r` contributes `weight / (RRF_K + r)` to its fused score, and
 * contributions accumulate across sources. The per-source breakdown in
 * `sourceScores[source]` stores that RRF contribution (not the raw score).
 *
 * An absolute relevance floor is applied per source BEFORE ranking:
 *   - vector: drop cosine scores < VECTOR_RELEVANCE_FLOOR
 *   - structural / dependency: drop scores <= 0
 *   - fts / graph: kept as-is (presence is already a relevance signal)
 */
function addSource(
  fused: Map<string, FusedCandidate>,
  source: RetrievalSource,
  results: SourceResult[],
  weight: number
): void {
  if (weight <= 0 || results.length === 0) return;
  const ranked = rankSourceResults(source, results);
  for (let i = 0; i < ranked.length; i++) {
    const result = ranked[i];
    const rank = i + 1; // 1-based rank within this source
    const contribution = weight / (RRF_K + rank);
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

/**
 * Sort a source's results by score descending and apply that source's absolute
 * relevance floor. Returns the surviving results in rank order (rank = index+1).
 */
function rankSourceResults(source: RetrievalSource, results: SourceResult[]): SourceResult[] {
  return [...results]
    .filter((result) => Number.isFinite(result.score) && passesRelevanceFloor(source, result.score))
    .sort((a, b) => b.score - a.score);
}

function passesRelevanceFloor(source: RetrievalSource, score: number): boolean {
  if (source === 'vector') return score >= VECTOR_RELEVANCE_FLOOR;
  if (source === 'structural' || source === 'dependency') return score > 0;
  // fts / graph: presence is the signal — keep as-is.
  return true;
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

/** Max corpus identifiers added per query term during corpus-derived expansion. */
const CORPUS_EXPANSION_PER_TERM = 6;

/**
 * Build a stem -> {corpus identifiers with that stem} index from the indexed
 * code symbols. This is the principled, repository-agnostic replacement for the
 * deleted hand-coded TERM_EXPANSIONS table: expansion targets are the symbols
 * that actually exist in THIS corpus, so the mechanism generalizes to any repo
 * instead of only matching this project's own names.
 */
function buildCorpusStemIndex(symbols: CodeSymbol[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const addVocab = (raw: string) => {
    const term = normalizeSymbolName(raw);
    if (term.length <= 2 || SPARSE_STOP_WORDS.has(term)) return;
    const stem = stemSparseTerm(term);
    if (stem.length < 3) return;
    let set = index.get(stem);
    if (!set) {
      set = new Set<string>();
      index.set(stem, set);
    }
    set.add(term);
  };
  for (const symbol of symbols) {
    addVocab(symbol.name);
    for (const part of splitIdentifier(symbol.name)) addVocab(part);
  }
  return index;
}

// Sparse structural terms are derived from the query (tokens, identifiers,
// split-identifier parts, conservative stems) and OPTIONALLY expanded against a
// vocabulary derived from the indexed corpus itself. The earlier hand-coded
// TERM_EXPANSIONS / PHRASE_EXPANSIONS tables mapped generic words to THIS repo's
// own symbols (train-on-test contamination); corpusStemIndex generalizes by
// expanding a query term to the real corpus identifiers that share its stem
// (e.g. "scoring" -> corpus symbols "scorer"/"score"), whatever repo is indexed.
function buildSparseStructuralTerms(
  structuralQuery: StructuralQuery,
  corpusStemIndex?: Map<string, Set<string>>
): SparseStructuralTerm[] {
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

  if (corpusStemIndex) {
    for (const { term, weight, origin } of [...terms.values()]) {
      if (origin === 'corpus') continue;
      const stem = stemSparseTerm(term);
      if (stem.length < 3) continue;
      const related = corpusStemIndex.get(stem);
      if (!related) continue;
      let added = 0;
      for (const corpusTerm of related) {
        if (corpusTerm === term) continue;
        add(corpusTerm, Math.min(0.5, weight * 0.7), 'corpus');
        if (++added >= CORPUS_EXPANSION_PER_TERM) break;
      }
    }
  }

  return [...terms.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 40);
}

function buildPathIntentTerms(sparseTerms: SparseStructuralTerm[]): string[] {
  return [...new Set(sparseTerms
    .filter((term) => term.weight >= 0.8 && term.origin === 'identifier')
    .map((term) => term.term)
    .filter((term) => term.length > 2 && !PATH_INTENT_STOP_WORDS.has(term)))];
}

// Common code words that must not be naively stemmed (e.g. "string" -> "str",
// "bytes" -> "byt", "class" -> "clas"). Combined with the length>=4 guard below.
const STEM_DENYLIST = new Set([
  'class', 'status', 'address', 'process', 'access', 'express', 'async', 'await',
  'string', 'bytes', 'native', 'series', 'species', 'analysis', 'business', 'success',
]);

function stemSparseTerm(value: string): string {
  const term = normalizeSymbolName(value);
  if (STEM_DENYLIST.has(term)) return term;
  let stem = term;
  if (term.endsWith('ies') && term.length > 5) stem = `${term.slice(0, -3)}y`;
  else if (term.endsWith('ing') && term.length > 6) stem = term.slice(0, -3);
  else if (term.endsWith('ed') && term.length > 5) stem = term.slice(0, -2);
  else if (term.endsWith('es') && term.length > 5) stem = term.slice(0, -2);
  else if (term.endsWith('s') && term.length > 4 && !term.endsWith('ss')) stem = term.slice(0, -1);
  return stem.length >= 4 ? stem : term;
}

function scoreSparseStructuralFields(
  chunk: ContextChunk,
  terms: SparseStructuralTerm[],
  symbols: CodeSymbol[],
  references: CodeReference[],
  strongIdentifiers: Set<string> = new Set(),
  strongIdentifierCases: Set<string> = new Set()
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

  const strongSymbolMatches = strongIdentifiers.size > 0
    ? symbolFields.filter((symbol) => strongIdentifiers.has(symbol.normalized))
    : [];
  if (strongSymbolMatches.length > 0) {
    score += 6 + Math.min(3, strongSymbolMatches.length * 0.75);
    if (reasons.length < 5) reasons.push(`sparse exact identifier symbol: ${strongSymbolMatches[0].name}`);
  }

  const strongCaseSymbolMatches = strongIdentifierCases.size > 0
    ? symbolFields.filter((symbol) => strongIdentifierCases.has(symbol.name))
    : [];
  if (strongCaseSymbolMatches.length > 0) {
    score += 3 + Math.min(2, strongCaseSymbolMatches.length * 0.5);
    if (reasons.length < 5) reasons.push(`sparse exact identifier case match: ${strongCaseSymbolMatches[0].name}`);
  }

  const strongReferenceMatches = strongIdentifiers.size > 0
    ? referenceFields.filter((reference) => strongIdentifiers.has(reference.normalized))
    : [];
  if (strongReferenceMatches.length > 0) {
    score += 2.2;
    if (reasons.length < 5) reasons.push(`sparse exact identifier reference: ${strongReferenceMatches[0].target}`);
  }

  const strongPathMatch = strongIdentifiers.size > 0
    && (strongIdentifiers.has(basenameNormalized) || [...basenameParts].some((part) => strongIdentifiers.has(part)));
  if (strongPathMatch) {
    score += 1.8;
    if (reasons.length < 5) reasons.push(`sparse exact identifier path: ${basenameStem}`);
  }

  const strongTextMatch = scoreStrongIdentifierText(chunk.text, strongIdentifiers);
  if (strongTextMatch.score > 0) {
    score += strongTextMatch.score;
    for (const reason of strongTextMatch.reasons) {
      if (reasons.length < 5) reasons.push(reason);
    }
  }

  const hasExactContract = reasons.some((reason) => reason.startsWith('sparse contract exact'));
  const hasStrongExactIdentifier = strongSymbolMatches.length > 0
    || strongReferenceMatches.length > 0
    || strongPathMatch
    || strongTextMatch.exact;
  const cap = hasStrongExactIdentifier ? 20 : hasExactContract ? 12 : 7;
  return { score: Math.min(cap, score), reasons };
}

function scoreStrongIdentifierText(
  text: string,
  strongIdentifiers: Set<string>
): { score: number; reasons: string[]; exact: boolean } {
  if (strongIdentifiers.size === 0 || text.length === 0) {
    return { score: 0, reasons: [], exact: false };
  }

  let score = 0;
  let exact = false;
  const reasons: string[] = [];
  for (const identifier of strongIdentifiers) {
    const escaped = escapeRegExp(identifier);
    const rightBoundary = `(?![A-Za-z0-9_$])`;
    const identifierBoundary = `(?:^|[^A-Za-z0-9_$])${escaped}${rightBoundary}`;
    const declarationPattern = new RegExp(
      `\\b(?:const|let|var)\\s+${escaped}${rightBoundary}\\s*(?::[^=;]+)?=|\\b(?:function|class|interface|type|def)\\s+${escaped}${rightBoundary}`,
      'i'
    );
    const fieldPattern = new RegExp(`${identifierBoundary}\\??\\s*:`, 'im');
    const occurrencePattern = new RegExp(identifierBoundary, 'gi');

    if (declarationPattern.test(text)) {
      score += 6.5;
      exact = true;
      if (reasons.length < 2) reasons.push(`sparse exact identifier declaration: ${identifier}`);
    } else if (fieldPattern.test(text)) {
      score += 2.2;
      exact = true;
      if (reasons.length < 2) reasons.push(`sparse exact identifier field: ${identifier}`);
    }

    const occurrenceCount = [...text.matchAll(occurrencePattern)].length;
    if (occurrenceCount > 0) {
      score += Math.min(1.5, occurrenceCount * 0.25);
      if (!exact && reasons.length < 2) {
        reasons.push(`sparse exact identifier text: ${identifier}`);
      }
    }
  }

  return { score, reasons, exact };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
