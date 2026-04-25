import type { ContextChunk, EmbeddingProvider } from '../types/index.js';
import type { SQLiteRepository } from '../storage/repository.js';

export interface RetrievalResult {
  chunkId: string;
  score: number;
  sources: ('vector' | 'fts' | 'graph')[];
  reasons: string[];
}

export interface RetrievalOptions {
  topK?: number;
  maxHops?: number;
  strategy?: 'hybrid' | 'vector' | 'text' | 'graph';
}

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

export class HybridRetriever {
  constructor(
    private storage: SQLiteRepository,
    private embeddingProvider: EmbeddingProvider
  ) {}

  async retrieve(query: string, options: RetrievalOptions = {}): Promise<RetrievalResult[]> {
    const { topK = 50, maxHops = 0, strategy = 'hybrid' } = options;
    const resultSets: { chunkId: string; score: number }[][] = [];
    const sourceNames: string[] = [];

    // Vector search
    if (strategy === 'hybrid' || strategy === 'vector') {
      const queryEmbedding = await this.embeddingProvider.embed(query);
      const vectorResults = this.storage.searchByVector(queryEmbedding, topK);
      if (vectorResults.length > 0) {
        resultSets.push(vectorResults);
        sourceNames.push('vector');
      }
    }

    // Full-text search
    if (strategy === 'hybrid' || strategy === 'text') {
      const ftsResults = this.storage.searchByText(query, topK);
      if (ftsResults.length > 0) {
        resultSets.push(ftsResults);
        sourceNames.push('fts');
      }
    }

    // Graph traversal from seed results
    if ((strategy === 'hybrid' || strategy === 'graph') && maxHops > 0 && resultSets.length > 0) {
      const seedIds = resultSets[0].slice(0, 10).map((r) => r.chunkId);
      const expanded = this.multiHopExpand(seedIds, maxHops, topK);
      if (expanded.length > 0) {
        resultSets.push(expanded);
        sourceNames.push('graph');
      }
    }

    // Pure graph strategy without seeds — use all chunks
    if (strategy === 'graph' && maxHops > 0 && resultSets.length === 0) {
      const allChunks = this.storage.getAllChunks();
      if (allChunks.length > 0) {
        // For pure graph, start from recently routed chunks
        const recentChunks = allChunks.slice(-10);
        const expanded = this.multiHopExpand(
          recentChunks.map((c) => c.id),
          maxHops,
          topK
        );
        if (expanded.length > 0) {
          resultSets.push(expanded);
          sourceNames.push('graph');
        }
      }
    }

    if (resultSets.length === 0) return [];

    // Fuse results
    const fused = reciprocalRankFusion(resultSets, sourceNames);

    // Sort by fused score and return
    const sorted = [...fused.entries()]
      .sort((a, b) => b[1].fusedScore - a[1].fusedScore)
      .slice(0, topK);

    // Build result objects with reasons
    return sorted.map(([chunkId, data]) => {
      const reasons: string[] = [];
      const sources = [...data.sources] as RetrievalResult['sources'];

      if (data.sources.has('vector')) reasons.push('vector similarity match');
      if (data.sources.has('fts')) reasons.push('keyword match (FTS5/BM25)');
      if (data.sources.has('graph')) reasons.push('dependency graph traversal');

      reasons.push(`fused score: ${data.fusedScore.toFixed(4)}`);

      return { chunkId, score: data.fusedScore, sources, reasons };
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
}
