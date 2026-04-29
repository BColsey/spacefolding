import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion } from '../src/core/retriever.js';
import type { RetrievalResult } from '../src/core/retriever.js';
import { detectIntent, expandQuery, planQuery, estimateComplexity } from '../src/core/query-planner.js';
import { fillBudget, compressOmitted } from '../src/core/budget.js';
import type { ContextChunk } from '../src/types/index.js';

describe('QueryPlanner', () => {
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

  it('debug plan uses vector-only with moderate budget', () => {
    const plan = planQuery('fix the error in login');
    expect(plan.intent).toBe('debug');
    expect(plan.strategy).toBe('vector');
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
