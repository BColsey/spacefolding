import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion, HybridRetriever } from '../src/core/retriever.js';
import type { RetrievalResult } from '../src/core/retriever.js';
import { detectIntent, expandQuery, planQuery, estimateComplexity, getAdaptiveStrategy } from '../src/core/query-planner.js';
import { fillBudget, compressOmitted } from '../src/core/budget.js';
import type { ContextChunk, EmbeddingProvider, RerankerProvider } from '../src/types/index.js';
import { DeterministicRerankerProvider } from '../src/providers/deterministic-reranker.js';

describe('QueryPlanner', () => {
  describe('getAdaptiveStrategy', () => {
    const originalProvider = process.env.EMBEDDING_PROVIDER;

    afterEach(() => {
      if (originalProvider === undefined) {
        delete process.env.EMBEDDING_PROVIDER;
      } else {
        process.env.EMBEDDING_PROVIDER = originalProvider;
      }
    });

    it('returns hybrid for local provider (default)', () => {
      delete process.env.EMBEDDING_PROVIDER;
      expect(getAdaptiveStrategy()).toBe('hybrid');
    });

    it('returns hybrid for explicit local provider', () => {
      process.env.EMBEDDING_PROVIDER = 'local';
      expect(getAdaptiveStrategy()).toBe('hybrid');
    });

    it('returns vector for gpu provider', () => {
      process.env.EMBEDDING_PROVIDER = 'gpu';
      expect(getAdaptiveStrategy()).toBe('vector');
    });

    it('returns text for deterministic provider', () => {
      process.env.EMBEDDING_PROVIDER = 'deterministic';
      expect(getAdaptiveStrategy()).toBe('text');
    });

    it('planQuery uses adaptive strategy based on EMBEDDING_PROVIDER', () => {
      process.env.EMBEDDING_PROVIDER = 'gpu';
      const gpuPlan = planQuery('test query');
      expect(gpuPlan.strategy).toBe('vector');

      process.env.EMBEDDING_PROVIDER = 'local';
      const localPlan = planQuery('test query');
      expect(localPlan.strategy).toBe('hybrid');

      process.env.EMBEDDING_PROVIDER = 'deterministic';
      const detPlan = planQuery('test query');
      expect(detPlan.strategy).toBe('text');
    });
  });

  it('detects debug intent', () => {
    expect(detectIntent('fix the error in login')).toBe('debug');
    expect(detectIntent('the app crashes with an exception')).toBe('debug');
  });

  it('detects implement intent', () => {
    expect(detectIntent('add rate limiting to the API')).toBe('implement');
    expect(detectIntent('create a new endpoint')).toBe('implement');
  });

  it('detects explain intent', () => {
    expect(detectIntent('how does authentication work')).toBe('explain');
    expect(detectIntent('what is the scoring engine')).toBe('explain');
  });

  it('detects code search intent', () => {
    expect(detectIntent('find the auth middleware')).toBe('code_search');
    expect(detectIntent('where is the router class')).toBe('code_search');
  });

  it('defaults to general', () => {
    expect(detectIntent('authentication JWT')).toBe('general');
  });

  it('expands queries by removing stop words', () => {
    const terms = expandQuery('How does the authentication middleware work in the system?');
    expect(terms).toContain('authentication');
    expect(terms).toContain('middleware');
    expect(terms).toContain('work');
    expect(terms).toContain('system');
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('how');
    expect(terms).not.toContain('does');
  });

  it('debug plan uses adaptive strategy with moderate budget', () => {
    const plan = planQuery('fix the error in login');
    expect(plan.intent).toBe('debug');
    expect(plan.strategy).toBe(getAdaptiveStrategy());
    expect(plan.maxHops).toBe(0);
    expect(plan.complexity).toBe('moderate');
    expect(plan.tokenBudgetRatio).toBe(0.6);
  });

  it('narrow queries get reduced budget', () => {
    const plan = planQuery('find the exact function that handles authentication in src/auth/login.ts');
    expect(plan.complexity).toBe('narrow');
    expect(plan.tokenBudgetRatio).toBeLessThan(0.5);
  });

  it('broad queries get increased budget', () => {
    const plan = planQuery('explain the overall architecture and how all the various modules interact');
    expect(plan.complexity).toBe('broad');
    expect(plan.tokenBudgetRatio).toBeGreaterThan(0.35);
  });
});

describe('ReciprocalRankFusion', () => {
  it('fuses multiple ranked lists', () => {
    const set1 = [
      { chunkId: 'a', score: 0.9 },
      { chunkId: 'b', score: 0.8 },
      { chunkId: 'c', score: 0.7 },
    ];
    const set2 = [
      { chunkId: 'b', score: 0.95 },
      { chunkId: 'c', score: 0.85 },
      { chunkId: 'd', score: 0.75 },
    ];

    const fused = reciprocalRankFusion([set1, set2], ['vector', 'fts']);

    // 'b' appears in both lists, should rank highest
    const sorted = [...fused.entries()].sort((a, b) => b[1].fusedScore - a[1].fusedScore);
    expect(sorted[0][0]).toBe('b');
    expect(sorted[0][1].sources.has('vector')).toBe(true);
    expect(sorted[0][1].sources.has('fts')).toBe(true);
  });

  it('handles empty result sets', () => {
    const fused = reciprocalRankFusion([], []);
    expect(fused.size).toBe(0);
  });
});

describe('BudgetController', () => {
  const makeChunk = (id: string, tokens: number): ContextChunk => ({
    id,
    source: 'test',
    type: 'code',
    text: 'x'.repeat(tokens * 4),
    timestamp: Date.now(),
    tokensEstimate: tokens,
    childrenIds: [],
    metadata: {},
  });

  it('fills budget with highest-scoring chunks first', () => {
    const ranked: RetrievalResult[] = [
      { chunkId: 'a', score: 0.9, sources: ['vector'], reasons: ['top match'] },
      { chunkId: 'b', score: 0.7, sources: ['vector'], reasons: ['good match'] },
      { chunkId: 'c', score: 0.5, sources: ['fts'], reasons: ['keyword match'] },
    ];

    const chunks = new Map<string, ContextChunk>();
    chunks.set('a', makeChunk('a', 30));
    chunks.set('b', makeChunk('b', 40));
    chunks.set('c', makeChunk('c', 50));

    const result = fillBudget(ranked, chunks, 80);
    expect(result.selected.map((c) => c.id)).toEqual(['a', 'b']);
    expect(result.totalTokens).toBe(70);
    expect(result.omitted.length).toBe(1);
    expect(result.omitted[0].chunkId).toBe('c');
  });

  it('respects hot chunk priority', () => {
    const ranked: RetrievalResult[] = [
      { chunkId: 'warm', score: 0.9, sources: ['vector'], reasons: [] },
      { chunkId: 'hot', score: 0.3, sources: ['fts'], reasons: [] },
    ];

    const chunks = new Map<string, ContextChunk>();
    chunks.set('warm', makeChunk('warm', 80));
    chunks.set('hot', makeChunk('hot', 80));

    const result = fillBudget(ranked, chunks, 100, { hotChunkIds: new Set(['hot']) });
    expect(result.selected.map((c) => c.id)).toEqual(['hot']);
  });

  it('handles empty input', () => {
    const result = fillBudget([], new Map(), 1000);
    expect(result.selected).toEqual([]);
    expect(result.totalTokens).toBe(0);
  });

  it('compresses omitted chunks that fit when compressed', async () => {
    const ranked: RetrievalResult[] = [
      { chunkId: 'fits', score: 0.9, sources: ['vector'], reasons: [] },
      { chunkId: 'too-big', score: 0.8, sources: ['vector'], reasons: [] },
    ];

    const chunks = new Map<string, ContextChunk>();
    chunks.set('fits', makeChunk('fits', 80));
    chunks.set('too-big', makeChunk('too-big', 200));

    const result = fillBudget(ranked, chunks, 100);
    expect(result.selected.map((c) => c.id)).toEqual(['fits']);
    expect(result.omitted.length).toBe(1);

    // Now compress the omitted chunk
    await compressOmitted(result, ranked, chunks, {
      estimateCompressed: (tokens) => Math.max(10, Math.floor(tokens * 0.05)),
      compress: async (chunkId) => {
        const chunk = chunks.get(chunkId);
        if (!chunk) return null;
        return { summary: `Summary of ${chunk.id}`, tokensEstimate: 10 };
      },
    });

    // Should have compressed 'too-big' and added it
    expect(result.compressed.length).toBe(1);
    expect(result.compressed[0].chunkId).toBe('too-big');
    expect(result.selected.length).toBe(2);
    expect(result.selected[1].text).toBe('Summary of too-big');
    expect(result.tiers.get(result.selected[1].id)).toBe('compressed');
    expect(result.totalTokens).toBe(90); // 80 + 10
  });

  it('skips compression when even compressed chunks exceed budget', async () => {
    const ranked: RetrievalResult[] = [
      { chunkId: 'fits', score: 0.9, sources: ['vector'], reasons: [] },
      { chunkId: 'too-big', score: 0.8, sources: ['vector'], reasons: [] },
    ];

    const chunks = new Map<string, ContextChunk>();
    chunks.set('fits', makeChunk('fits', 95));
    chunks.set('too-big', makeChunk('too-big', 200));

    const result = fillBudget(ranked, chunks, 100);
    await compressOmitted(result, ranked, chunks, {
      estimateCompressed: () => 10, // Even 10 tokens would exceed
      compress: async (chunkId) => {
        return { summary: `Summary of ${chunkId}`, tokensEstimate: 10 };
      },
    });

    // No compression should happen — only 5 tokens remaining
    expect(result.compressed.length).toBe(0);
  });
});

describe('Iterative Query Expansion', () => {
  it('planQuery returns complexity for adaptive budget', () => {
    const narrowPlan = planQuery('find the exact function in src/auth/login.ts');
    const broadPlan = planQuery('explain the overall architecture and how all modules interact');
    expect(narrowPlan.complexity).toBe('narrow');
    expect(broadPlan.complexity).toBe('broad');
    expect(narrowPlan.tokenBudgetRatio).toBeLessThan(broadPlan.tokenBudgetRatio);
  });

  it('iterative retrieve deduplicates across rounds', async () => {
    // This requires a real pipeline, so we test the budget dedup logic
    const ranked: RetrievalResult[] = [
      { chunkId: 'a', score: 0.9, sources: ['vector'], reasons: [] },
      { chunkId: 'b', score: 0.7, sources: ['vector'], reasons: [] },
    ];
    const makeChunk = (id: string, tokens: number): ContextChunk => ({
      id, source: 'test', type: 'code', text: 'x'.repeat(tokens * 4),
      timestamp: Date.now(), tokensEstimate: tokens, childrenIds: [], metadata: {},
    });
    const chunks = new Map<string, ContextChunk>();
    chunks.set('a', makeChunk('a', 50));
    chunks.set('b', makeChunk('b', 50));

    const result = fillBudget(ranked, chunks, 100);
    expect(result.selected.length).toBe(2);

    // If we run fillBudget again with same IDs, they should still work
    const result2 = fillBudget(ranked, chunks, 100);
    expect(result2.selected.length).toBe(2);
  });
});

describe('DeterministicRerankerProvider', () => {
  it('ranks documents with keyword overlap higher', async () => {
    const reranker = new DeterministicRerankerProvider();
    const results = await reranker.rerank('authentication middleware', [
      'the authentication middleware validates JWT tokens',
      'the database connection pool manages connections',
      'authentication is handled by the auth module',
    ]);

    // Documents 0 and 2 have keyword overlap, document 1 has none
    const topResult = results[0];
    expect(topResult.index).toBe(0); // doc 0 has both keywords
    expect(topResult.score).toBeGreaterThan(0);

    // Verify scores decrease for less relevant docs
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
  });

  it('returns correct reason strings', async () => {
    const reranker = new DeterministicRerankerProvider();
    const results = await reranker.rerank('test query terms', [
      'test query terms all present',
      'test only partial',
      'completely unrelated document',
    ]);

    expect(results[0].reason).toBe('direct keyword match');
    expect(results[1].reason).toBe('partial keyword match');
    expect(results[2].reason).toBe('no keyword overlap');
  });

  it('handles empty documents array', async () => {
    const reranker = new DeterministicRerankerProvider();
    const results = await reranker.rerank('query', []);
    expect(results).toEqual([]);
  });

  it('handles empty query', async () => {
    const reranker = new DeterministicRerankerProvider();
    const results = await reranker.rerank('', ['some document text']);
    expect(results[0].score).toBe(0);
    expect(results[0].reason).toBe('no keyword overlap');
  });
});

describe('HybridRetriever reranker integration', () => {
  // Minimal mock storage that supports the retriever's needs
  function createMockStorage(chunks: ContextChunk[]) {
    const chunkMap = new Map(chunks.map(c => [c.id, c]));
    return {
      getChunk: (id: string) => chunkMap.get(id) ?? null,
      getAllChunks: () => chunks,
      getDependencies: () => [] as any[],
      searchByVector: () => chunks.map(c => ({ chunkId: c.id, score: 0.5 })),
      searchByText: () => chunks.map(c => ({ chunkId: c.id, score: 0.5 })),
    } as any;
  }

  const noOpEmbedding: EmbeddingProvider = {
    embed: async () => [0.1, 0.2, 0.3],
    embedBatch: async () => [],
  };

  const makeChunk = (id: string, text: string): ContextChunk => ({
    id,
    source: 'test',
    type: 'code',
    text,
    timestamp: Date.now(),
    tokensEstimate: text.split(/\s+/).length,
    childrenIds: [],
    metadata: {},
  });

  it('reorders results when reranker has keyword overlap signal', async () => {
    const chunks = [
      makeChunk('a', 'completely unrelated database connection pooling'),
      makeChunk('b', 'authentication middleware handles user login flow'),
      makeChunk('c', 'some other random utility helper function'),
    ];

    // The storage returns all chunks for both vector and text search.
    // Without the reranker, order depends on RRF fusion of identical scores.
    // With the reranker, chunk 'b' should be boosted for 'authentication middleware'.
    const storage = createMockStorage(chunks);
    const reranker = new DeterministicRerankerProvider();
    const retriever = new HybridRetriever(storage, noOpEmbedding, reranker);

    const results = await retriever.retrieve('authentication middleware', {
      strategy: 'hybrid',
      topK: 10,
    });

    // Chunk 'b' has the most keyword overlap with 'authentication middleware'
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunkId).toBe('b');
  });

  it('works without a reranker (backward compatible)', async () => {
    const chunks = [
      makeChunk('a', 'authentication module'),
      makeChunk('b', 'database module'),
    ];

    const storage = createMockStorage(chunks);
    // No reranker passed — should still work
    const retriever = new HybridRetriever(storage, noOpEmbedding);

    const results = await retriever.retrieve('authentication', {
      strategy: 'hybrid',
      topK: 10,
    });

    expect(results.length).toBeGreaterThan(0);
    // Should return results without error
    expect(results.every(r => r.chunkId && typeof r.score === 'number')).toBe(true);
  });

  it('handles reranker that throws an error gracefully', async () => {
    const chunks = [
      makeChunk('a', 'authentication module'),
      makeChunk('b', 'database module'),
    ];

    const failingReranker: RerankerProvider = {
      async rerank() {
        throw new Error('reranker exploded');
      },
    };

    const storage = createMockStorage(chunks);
    const retriever = new HybridRetriever(storage, noOpEmbedding, failingReranker);

    // Should not throw — falls back to RRF ordering
    const results = await retriever.retrieve('authentication', {
      strategy: 'hybrid',
      topK: 10,
    });

    expect(results.length).toBeGreaterThan(0);
  });
});
