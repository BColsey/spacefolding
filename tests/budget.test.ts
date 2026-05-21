import { describe, it, expect } from 'vitest';
import { fillBudget, compressOmitted } from '../src/core/budget.js';
import type { ContextChunk } from '../src/types/index.js';
import type { RetrievalResult } from '../src/core/retriever.js';

function makeChunk(overrides: Partial<ContextChunk> & { id: string }): ContextChunk {
  return {
    source: 'test',
    type: 'code',
    text: 'test text',
    timestamp: Date.now(),
    tokensEstimate: 10,
    childrenIds: [],
    metadata: {},
    ...overrides,
  };
}

function makeResult(chunkId: string, score: number): RetrievalResult {
  return { chunkId, score, sources: ['vector'], reasons: [] };
}

function buildChunksMap(chunks: ContextChunk[]): Map<string, ContextChunk> {
  const map = new Map<string, ContextChunk>();
  for (const chunk of chunks) map.set(chunk.id, chunk);
  return map;
}

describe('fillBudget', () => {
  it('includes hot-tier chunks first even with low scores', () => {
    const hotChunk = makeChunk({ id: 'hot-1', tokensEstimate: 50 });
    const highScoreChunk = makeChunk({ id: 'score-1', tokensEstimate: 50 });

    const ranked: RetrievalResult[] = [
      makeResult('score-1', 0.95),
      makeResult('hot-1', 0.1),
    ];
    const chunks = buildChunksMap([hotChunk, highScoreChunk]);

    const result = fillBudget(ranked, chunks, 100, {
      hotChunkIds: new Set(['hot-1']),
    });

    // hot-1 should appear first despite lower score
    expect(result.selected[0].id).toBe('hot-1');
    expect(result.selected).toHaveLength(2);
    expect(result.tiers.get('hot-1')).toBe('hot');
    expect(result.tiers.get('score-1')).toBe('warm');
  });

  it('omits chunks that exceed remaining budget', () => {
    const chunk1 = makeChunk({ id: 'a', tokensEstimate: 60 });
    const chunk2 = makeChunk({ id: 'b', tokensEstimate: 50 });
    const chunk3 = makeChunk({ id: 'c', tokensEstimate: 30 });

    const ranked: RetrievalResult[] = [
      makeResult('a', 0.9),
      makeResult('b', 0.8),
      makeResult('c', 0.7),
    ];
    const chunks = buildChunksMap([chunk1, chunk2, chunk3]);

    // Budget=100: a=60 fits, remaining=40. b=50 > 40 omitted. c=30 fits, total=90.
    const result = fillBudget(ranked, chunks, 100);

    expect(result.selected.map((c) => c.id)).toEqual(['a', 'c']);
    expect(result.omitted).toHaveLength(1);
    expect(result.omitted[0]).toEqual({
      chunkId: 'b',
      tokensEstimate: 50,
      reason: 'exceeds remaining budget',
    });
  });

  it('collapses siblings when collapseSiblings is true and parentId matches', () => {
    const parent = makeChunk({ id: 'parent-1', tokensEstimate: 30 });
    const child = makeChunk({ id: 'child-1', tokensEstimate: 30, parentId: 'parent-1' });

    const ranked: RetrievalResult[] = [
      makeResult('parent-1', 0.9),
      makeResult('child-1', 0.8),
    ];
    const chunks = buildChunksMap([parent, child]);

    const result = fillBudget(ranked, chunks, 200, { collapseSiblings: true });

    expect(result.selected.map((c) => c.id)).toEqual(['parent-1']);
    expect(result.omitted).toHaveLength(1);
    expect(result.omitted[0].reason).toBe('parent already included');
  });

  it('does not collapse siblings when collapseSiblings is false', () => {
    const parent = makeChunk({ id: 'parent-1', tokensEstimate: 30 });
    const child = makeChunk({ id: 'child-1', tokensEstimate: 30, parentId: 'parent-1' });

    const ranked: RetrievalResult[] = [
      makeResult('parent-1', 0.9),
      makeResult('child-1', 0.8),
    ];
    const chunks = buildChunksMap([parent, child]);

    const result = fillBudget(ranked, chunks, 200);

    expect(result.selected).toHaveLength(2);
  });

  it('calculates utilization correctly', () => {
    const chunk = makeChunk({ id: 'a', tokensEstimate: 40 });
    const ranked = [makeResult('a', 0.9)];
    const chunks = buildChunksMap([chunk]);

    const result = fillBudget(ranked, chunks, 200);

    expect(result.utilization).toBe(0.2);
    expect(result.totalTokens).toBe(40);
    expect(result.budget).toBe(200);
  });

  it('returns empty selection when maxTokens is 0', () => {
    const chunk = makeChunk({ id: 'a', tokensEstimate: 10 });
    const ranked = [makeResult('a', 0.9)];
    const chunks = buildChunksMap([chunk]);

    const result = fillBudget(ranked, chunks, 0);

    expect(result.selected).toHaveLength(0);
    expect(result.totalTokens).toBe(0);
    expect(result.utilization).toBe(0);
  });

  it('ranks higher-scored chunks first in normal flow', () => {
    const chunks = [
      makeChunk({ id: 'low', tokensEstimate: 20 }),
      makeChunk({ id: 'mid', tokensEstimate: 20 }),
      makeChunk({ id: 'high', tokensEstimate: 20 }),
    ];
    const ranked: RetrievalResult[] = [
      makeResult('high', 0.9),
      makeResult('mid', 0.5),
      makeResult('low', 0.1),
    ];
    const chunksMap = buildChunksMap(chunks);

    const result = fillBudget(ranked, chunksMap, 100);

    expect(result.selected.map((c) => c.id)).toEqual(['high', 'mid', 'low']);
  });

  it('omits hot chunks that individually exceed budget', () => {
    const hotChunk = makeChunk({ id: 'hot-big', tokensEstimate: 500 });
    const normalChunk = makeChunk({ id: 'normal-1', tokensEstimate: 50 });
    const ranked = [
      makeResult('hot-big', 0.9),
      makeResult('normal-1', 0.5),
    ];
    const chunks = buildChunksMap([hotChunk, normalChunk]);

    const result = fillBudget(ranked, chunks, 100, {
      hotChunkIds: new Set(['hot-big']),
    });

    // hot-big is omitted in phase 1 (exceeds budget), then in phase 2 it is NOT in `included`
    // so it gets another omission for 'exceeds remaining budget' (since it's not in included set)
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0].id).toBe('normal-1');
    // hot-big is omitted twice: once in hot phase, once in normal phase
    expect(result.omitted.length).toBeGreaterThanOrEqual(1);
    expect(result.omitted[0].reason).toBe('hot but exceeds budget');
  });

  it('skips results whose chunkId is not in the chunks map', () => {
    const ranked = [makeResult('missing', 0.9)];
    const chunks = new Map<string, ContextChunk>();

    const result = fillBudget(ranked, chunks, 100);

    expect(result.selected).toHaveLength(0);
    expect(result.totalTokens).toBe(0);
  });
});

describe('compressOmitted', () => {
  it('only compresses chunks with "exceeds remaining budget" reason', async () => {
    const chunk1 = makeChunk({ id: 'a', tokensEstimate: 30 });
    const chunk2 = makeChunk({ id: 'b', tokensEstimate: 30 });
    const chunk3 = makeChunk({ id: 'c', tokensEstimate: 30 });

    const ranked: RetrievalResult[] = [
      makeResult('a', 0.9),
      makeResult('b', 0.8),
      makeResult('c', 0.7),
    ];

    const allChunks = buildChunksMap([chunk1, chunk2, chunk3]);

    // Budget=50: a=30 fits (remaining=20). b=30 > 20 omitted. c=30 > 20 omitted.
    const budgetResult = fillBudget(ranked, allChunks, 50);

    // Now manually change one omitted reason to a non-budget reason
    const budgetOmitted = budgetResult.omitted.find((o) => o.chunkId === 'b')!;
    budgetOmitted.reason = 'parent already included';

    const compressed = await compressOmitted(budgetResult, ranked, allChunks, {
      estimateCompressed: () => 15,
      compress: async (chunkId) => ({
        summary: 'summary of ' + chunkId,
        tokensEstimate: 15,
      }),
    });

    // Only the 'exceeds remaining budget' item (c) should be compressed, not b
    expect(compressed).toHaveLength(1);
    expect(compressed[0].chunkId).toBe('c');
  });

  it('compresses budget-exceeding chunks that fit when compressed', async () => {
    const chunk1 = makeChunk({ id: 'a', tokensEstimate: 30 });
    const chunk2 = makeChunk({ id: 'b', tokensEstimate: 200 });

    const ranked: RetrievalResult[] = [
      makeResult('a', 0.9),
      makeResult('b', 0.8),
    ];
    const allChunks = buildChunksMap([chunk1, chunk2]);

    // Budget 100, a takes 30, b (200) won't fit raw but compressed to 50 fits
    const budgetResult = fillBudget(ranked, allChunks, 100);

    expect(budgetResult.selected).toHaveLength(1);
    expect(budgetResult.omitted).toHaveLength(1);
    expect(budgetResult.omitted[0].reason).toBe('exceeds remaining budget');

    const compressed = await compressOmitted(budgetResult, ranked, allChunks, {
      estimateCompressed: () => 50,
      compress: async (chunkId) => ({
        summary: 'compressed ' + chunkId,
        tokensEstimate: 50,
      }),
    });

    expect(compressed).toHaveLength(1);
    expect(compressed[0].chunkId).toBe('b');
    expect(budgetResult.compressed).toHaveLength(1);
  });

  it('rejects compressed chunks that still exceed budget', async () => {
    const chunk1 = makeChunk({ id: 'a', tokensEstimate: 90 });
    const chunk2 = makeChunk({ id: 'b', tokensEstimate: 500 });

    const ranked: RetrievalResult[] = [
      makeResult('a', 0.9),
      makeResult('b', 0.8),
    ];
    const allChunks = buildChunksMap([chunk1, chunk2]);

    const budgetResult = fillBudget(ranked, allChunks, 100);

    // a=90 fits, b=500 doesn't. Remaining = 10. Compressed b=50 still > 10
    const compressed = await compressOmitted(budgetResult, ranked, allChunks, {
      estimateCompressed: () => 50,
      compress: async (chunkId) => ({
        summary: 'compressed ' + chunkId,
        tokensEstimate: 50,
      }),
    });

    expect(compressed).toHaveLength(0);
    expect(budgetResult.selected).toHaveLength(1);
  });

  it('mutates budget result correctly with compressed entries', async () => {
    const chunk1 = makeChunk({ id: 'a', tokensEstimate: 10 });
    const chunk2 = makeChunk({ id: 'b', tokensEstimate: 200 });

    const ranked: RetrievalResult[] = [
      makeResult('a', 0.9),
      makeResult('b', 0.8),
    ];
    const allChunks = buildChunksMap([chunk1, chunk2]);

    const budgetResult = fillBudget(ranked, allChunks, 100);
    const tokensBefore = budgetResult.totalTokens;

    await compressOmitted(budgetResult, ranked, allChunks, {
      estimateCompressed: () => 30,
      compress: async (chunkId) => ({
        summary: 'summary',
        tokensEstimate: 30,
      }),
    });

    expect(budgetResult.totalTokens).toBe(tokensBefore + 30);
    expect(budgetResult.selected).toHaveLength(2);
    expect(budgetResult.selected[1].id).toBe('b__compressed');
    expect(budgetResult.tiers.get('b__compressed')).toBe('compressed');
    expect(budgetResult.utilization).toBeCloseTo(40 / 100);
    // Original omitted entry for 'b' should be removed
    expect(budgetResult.omitted.find((o) => o.chunkId === 'b')).toBeUndefined();
  });

  it('returns empty when no remaining budget', async () => {
    const chunk = makeChunk({ id: 'a', tokensEstimate: 100 });
    const ranked = [makeResult('a', 0.9)];
    const chunks = buildChunksMap([chunk]);

    const budgetResult = fillBudget(ranked, chunks, 100);
    expect(budgetResult.totalTokens).toBe(100);

    const compressed = await compressOmitted(budgetResult, ranked, chunks, {
      estimateCompressed: () => 10,
      compress: async (id) => ({ summary: 'x', tokensEstimate: 10 }),
    });

    expect(compressed).toHaveLength(0);
  });

  it('respects maxCompress option', async () => {
    const chunks = [
      makeChunk({ id: 'fit', tokensEstimate: 10 }),
      makeChunk({ id: 'big1', tokensEstimate: 200 }),
      makeChunk({ id: 'big2', tokensEstimate: 200 }),
      makeChunk({ id: 'big3', tokensEstimate: 200 }),
    ];
    const ranked: RetrievalResult[] = [
      makeResult('fit', 0.9),
      makeResult('big1', 0.8),
      makeResult('big2', 0.7),
      makeResult('big3', 0.6),
    ];
    const allChunks = buildChunksMap(chunks);

    const budgetResult = fillBudget(ranked, allChunks, 200);

    const compressed = await compressOmitted(budgetResult, ranked, allChunks, {
      estimateCompressed: () => 30,
      compress: async (chunkId) => ({
        summary: 'summary ' + chunkId,
        tokensEstimate: 30,
      }),
      maxCompress: 1,
    });

    // Only 1 of the 3 big chunks should be compressed
    expect(compressed).toHaveLength(1);
  });
});
