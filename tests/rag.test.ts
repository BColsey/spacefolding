import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion } from '../src/core/retriever.js';
import type { RetrievalResult } from '../src/core/retriever.js';
import { detectIntent, expandQuery, planQuery } from '../src/core/query-planner.js';
import { fillBudget } from '../src/core/budget.js';
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

  it('debug plan uses hybrid with high budget', () => {
    const plan = planQuery('fix the error in login');
    expect(plan.intent).toBe('debug');
    expect(plan.strategy).toBe('hybrid');
    expect(plan.maxHops).toBe(2);
    expect(plan.tokenBudgetRatio).toBe(0.6);
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
});
