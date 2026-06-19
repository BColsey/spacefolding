import { describe, it, expect } from 'vitest';
import {
  createRetrievalSelectionPolicy,
  selectRetrievalCandidates,
  budgetForSelectedCandidates,
} from '../src/core/retrieval-policy.js';
import type { ContextChunk } from '../src/types/index.js';
import type { RetrievalResult } from '../src/core/retriever.js';

function makeChunk(overrides: Partial<ContextChunk> & { id: string }): ContextChunk {
  return {
    source: 'test',
    type: 'code',
    text: 'test text',
    timestamp: Date.now(),
    tokensEstimate: 100,
    childrenIds: [],
    metadata: {},
    ...overrides,
  };
}

function makeResult(chunkId: string, score: number): RetrievalResult {
  return { chunkId, score, sources: ['vector'], reasons: [] };
}

describe('createRetrievalSelectionPolicy', () => {
  it('returns focused policy by default', () => {
    const policy = createRetrievalSelectionPolicy({
      complexity: 'moderate',
      hardBudget: 50_000,
      requestedTopK: 10,
    });

    expect(policy.mode).toBe('focused');
    expect(policy.scoreThresholdRatio).toBe(0.35);
    expect(policy.minKeep).toBe(3);
    expect(policy.maxChunksPerPath).toBe(2);
    expect(policy.targetBudget).toBe(13_000); // FOCUSED_TARGETS.moderate
  });

  it('returns focused policy with narrow complexity target', () => {
    const policy = createRetrievalSelectionPolicy({
      complexity: 'narrow',
      hardBudget: 50_000,
      requestedTopK: 10,
    });

    expect(policy.mode).toBe('focused');
    expect(policy.targetBudget).toBe(6_000);
  });

  it('returns focused policy with broad complexity target', () => {
    const policy = createRetrievalSelectionPolicy({
      complexity: 'broad',
      hardBudget: 50_000,
      requestedTopK: 10,
    });

    expect(policy.mode).toBe('focused');
    expect(policy.targetBudget).toBe(18_000);
  });

  it('returns broad policy with correct thresholds', () => {
    const policy = createRetrievalSelectionPolicy({
      mode: 'broad',
      complexity: 'moderate',
      hardBudget: 50_000,
      requestedTopK: 10,
    });

    expect(policy.mode).toBe('broad');
    expect(policy.scoreThresholdRatio).toBe(0.2);
    expect(policy.minKeep).toBe(5);
    expect(policy.maxChunksPerPath).toBe(3);
    expect(policy.targetBudget).toBe(28_000); // BROAD_TARGETS.moderate
  });

  it('returns broad policy with narrow complexity target', () => {
    const policy = createRetrievalSelectionPolicy({
      mode: 'broad',
      complexity: 'narrow',
      hardBudget: 50_000,
      requestedTopK: 10,
    });

    expect(policy.targetBudget).toBe(16_000);
  });

  it('returns broad policy with broad complexity target', () => {
    const policy = createRetrievalSelectionPolicy({
      mode: 'broad',
      complexity: 'broad',
      hardBudget: 50_000,
      requestedTopK: 10,
    });

    expect(policy.targetBudget).toBe(40_000);
  });

  it('returns exhaustive policy with hard budget as target', () => {
    const policy = createRetrievalSelectionPolicy({
      mode: 'exhaustive',
      complexity: 'moderate',
      hardBudget: 50_000,
      requestedTopK: 10,
    });

    expect(policy.mode).toBe('exhaustive');
    expect(policy.hardBudget).toBe(50_000);
    expect(policy.targetBudget).toBe(50_000);
    expect(policy.scoreThresholdRatio).toBe(0);
    expect(policy.minKeep).toBe(0);
    expect(policy.maxChunksPerPath).toBeNull();
    // Exhaustive returns everything up to budget — no absolute floor.
    expect(policy.absoluteScoreFloor).toBe(0);
  });

  it('wires the absolute fused-score floor into focused and broad policies', () => {
    // 1 / (RRF_K + retrieval tail rank) = 1 / (60 + 200): the contribution a
    // single unit-weight source makes at the deepest retrieved rank.
    const expectedFloor = 1 / 260;
    for (const mode of ['focused', 'broad'] as const) {
      const policy = createRetrievalSelectionPolicy({
        mode,
        complexity: 'moderate',
        hardBudget: 50_000,
        requestedTopK: 10,
      });
      expect(policy.absoluteScoreFloor).toBeCloseTo(expectedFloor, 6);
    }
  });

  it('caps target budget at hard budget', () => {
    const policy = createRetrievalSelectionPolicy({
      complexity: 'broad',
      hardBudget: 5_000,
      requestedTopK: 10,
    });

    // FOCUSED_TARGETS.broad = 18_000, but hard budget is 5_000
    expect(policy.targetBudget).toBe(5_000);
  });

  it('uses returnLimit for candidateLimit when provided', () => {
    const policy = createRetrievalSelectionPolicy({
      complexity: 'moderate',
      hardBudget: 50_000,
      requestedTopK: 20,
      returnLimit: 5,
    });

    expect(policy.candidateLimit).toBe(5);
  });

  it('uses requestedTopK for candidateLimit when returnLimit not provided', () => {
    const policy = createRetrievalSelectionPolicy({
      complexity: 'moderate',
      hardBudget: 50_000,
      requestedTopK: 15,
    });

    expect(policy.candidateLimit).toBe(15);
  });
});

describe('selectRetrievalCandidates', () => {
  function makePolicy(overrides: Partial<ReturnType<typeof createRetrievalSelectionPolicy>> = {}) {
    return {
      mode: 'focused' as const,
      hardBudget: 50_000,
      targetBudget: 13_000,
      candidateLimit: 10,
      minKeep: 3,
      scoreThresholdRatio: 0.35,
      absoluteScoreFloor: 0, // default off so these tests isolate the relative threshold
      maxChunksPerPath: 2,
      ...overrides,
    };
  }

  it('filters by score threshold', () => {
    const chunks = new Map<string, ContextChunk>([
      ['high', makeChunk({ id: 'high' })],
      ['mid', makeChunk({ id: 'mid' })],
      ['low', makeChunk({ id: 'low' })],
    ]);

    // topScore = 1.0, threshold = 1.0 * 0.35 = 0.35
    const retrieval: RetrievalResult[] = [
      makeResult('high', 1.0),
      makeResult('mid', 0.5),
      makeResult('low', 0.2), // below threshold
    ];

    const policy = makePolicy({ minKeep: 0 }); // disable minKeep for pure threshold test
    const result = selectRetrievalCandidates(retrieval, chunks, policy);

    expect(result.ranked.map((r) => r.chunkId)).toEqual(['high', 'mid']);
    expect(result.dropped.some((d) => d.chunkId === 'low')).toBe(true);
    expect(result.dropped.find((d) => d.chunkId === 'low')?.reason).toContain('score threshold');
  });

  it('protects first minKeep candidates regardless of score', () => {
    const chunks = new Map<string, ContextChunk>([
      ['a', makeChunk({ id: 'a' })],
      ['b', makeChunk({ id: 'b' })],
      ['c', makeChunk({ id: 'c' })],
      ['d', makeChunk({ id: 'd' })],
    ]);

    // topScore = 1.0, threshold = 0.35. 'd' has score 0.1 (< threshold) but is protected by minKeep=3
    const retrieval: RetrievalResult[] = [
      makeResult('a', 1.0),
      makeResult('b', 0.6),
      makeResult('c', 0.5),
      makeResult('d', 0.1),
    ];

    const policy = makePolicy({ minKeep: 3 });
    const result = selectRetrievalCandidates(retrieval, chunks, policy);

    expect(result.ranked.map((r) => r.chunkId)).toContain('a');
    expect(result.ranked.map((r) => r.chunkId)).toContain('b');
    expect(result.ranked.map((r) => r.chunkId)).toContain('c');
    // d is at index 3, beyond minKeep=3, and score 0.1 < 0.35 threshold
    expect(result.dropped.some((d) => d.chunkId === 'd')).toBe(true);
  });

  it('enforces maxChunksPerPath', () => {
    const chunks = new Map<string, ContextChunk>([
      ['a', makeChunk({ id: 'a', path: 'src/auth.ts' })],
      ['b', makeChunk({ id: 'b', path: 'src/auth.ts' })],
      ['c', makeChunk({ id: 'c', path: 'src/auth.ts' })],
      ['other', makeChunk({ id: 'other', path: 'src/util.ts' })],
    ]);

    const retrieval: RetrievalResult[] = [
      makeResult('a', 1.0),
      makeResult('b', 0.9),
      makeResult('c', 0.8),
      makeResult('other', 0.7),
    ];

    // minKeep=0 so no protection; maxChunksPerPath=2 caps auth.ts at 2
    const policy = makePolicy({ minKeep: 0, maxChunksPerPath: 2, scoreThresholdRatio: 0 });
    const result = selectRetrievalCandidates(retrieval, chunks, policy);

    const authChunks = result.ranked.filter((r) => {
      const chunk = chunks.get(r.chunkId);
      return chunk?.path === 'src/auth.ts';
    });
    expect(authChunks).toHaveLength(2);
    expect(result.dropped.some((d) => d.chunkId === 'c')).toBe(true);
    expect(result.dropped.find((d) => d.chunkId === 'c')?.reason).toContain('per-path');
    // 'other' from different path should still be selected
    expect(result.ranked.map((r) => r.chunkId)).toContain('other');
  });

  it('caps at candidateLimit', () => {
    const chunks = new Map<string, ContextChunk>();
    const retrieval: RetrievalResult[] = [];
    for (let i = 0; i < 10; i++) {
      const id = `chunk-${i}`;
      // Give each a unique path so maxChunksPerPath doesn't interfere
      chunks.set(id, makeChunk({ id, path: `src/file-${i}.ts` }));
      retrieval.push(makeResult(id, 1.0 - i * 0.01));
    }

    const policy = makePolicy({ candidateLimit: 3, minKeep: 0, scoreThresholdRatio: 0, maxChunksPerPath: null });
    const result = selectRetrievalCandidates(retrieval, chunks, policy);

    expect(result.ranked).toHaveLength(3);
    expect(result.dropped).toHaveLength(7);
    expect(result.dropped[0].reason).toContain('candidate limit');
  });

  it('returns empty selection for empty input', () => {
    const chunks = new Map<string, ContextChunk>();
    const policy = makePolicy();
    const result = selectRetrievalCandidates([], chunks, policy);

    expect(result.ranked).toHaveLength(0);
    expect(result.dropped).toHaveLength(0);
  });

  it('keeps at least one candidate when input is non-empty', () => {
    const chunks = new Map<string, ContextChunk>([
      ['only', makeChunk({ id: 'only' })],
    ]);
    const retrieval = [makeResult('only', 0.01)];

    const policy = makePolicy({
      scoreThresholdRatio: 0.99, // threshold = 0.01 * 0.99 = 0.0099, score 0.01 > 0.0099 barely
      minKeep: 0,
    });
    const result = selectRetrievalCandidates(retrieval, chunks, policy);

    expect(result.ranked).toHaveLength(1);
  });

  it('forces first candidate in when none pass filter', () => {
    const chunks = new Map<string, ContextChunk>([
      ['a', makeChunk({ id: 'a' })],
      ['b', makeChunk({ id: 'b' })],
    ]);
    const retrieval = [
      makeResult('a', 0.01),
      makeResult('b', 0.005),
    ];

    const policy = makePolicy({
      scoreThresholdRatio: 1.0, // threshold = 0.01, so both fail
      minKeep: 0,
    });
    const result = selectRetrievalCandidates(retrieval, chunks, policy);

    // Should still have at least the first candidate
    expect(result.ranked).toHaveLength(1);
    expect(result.ranked[0].chunkId).toBe('a');
  });

  it('absolute floor drops a tail candidate the relative threshold would keep', () => {
    const chunks = new Map<string, ContextChunk>([
      ['top', makeChunk({ id: 'top' })],
      ['tail', makeChunk({ id: 'tail' })],
    ]);
    // Weak set: topScore 0.008 → relativeThreshold = 0.008 * 0.35 = 0.0028.
    // 'tail' at 0.003 clears the relative threshold but is below the absolute
    // floor (1/260 ≈ 0.00385), so only the absolute floor can catch it.
    const retrieval = [makeResult('top', 0.008), makeResult('tail', 0.003)];

    // Control: floor disabled → relative threshold keeps both.
    const noFloor = selectRetrievalCandidates(
      retrieval,
      chunks,
      makePolicy({ minKeep: 0, scoreThresholdRatio: 0.35, absoluteScoreFloor: 0 })
    );
    expect(noFloor.ranked.map((r) => r.chunkId)).toEqual(['top', 'tail']);

    // Floor on → 'tail' is dropped with the absolute-floor reason.
    const withFloor = selectRetrievalCandidates(
      retrieval,
      chunks,
      makePolicy({ minKeep: 0, scoreThresholdRatio: 0.35, absoluteScoreFloor: 1 / 260 })
    );
    expect(withFloor.ranked.map((r) => r.chunkId)).toEqual(['top']);
    expect(withFloor.dropped.find((d) => d.chunkId === 'tail')?.reason).toBe(
      'below absolute relevance floor'
    );
  });

  it('absolute floor is a no-op when a strong top hit makes the relative threshold dominate', () => {
    const chunks = new Map<string, ContextChunk>([
      ['top', makeChunk({ id: 'top' })],
      ['mid', makeChunk({ id: 'mid' })],
    ]);
    // Strong set: topScore 1.0 → relativeThreshold 0.35 >> absolute floor, so the
    // floor never binds and selection matches the pure relative-threshold result.
    const retrieval = [makeResult('top', 1.0), makeResult('mid', 0.5)];
    const result = selectRetrievalCandidates(
      retrieval,
      chunks,
      makePolicy({ minKeep: 0, scoreThresholdRatio: 0.35, absoluteScoreFloor: 1 / 260 })
    );
    expect(result.ranked.map((r) => r.chunkId)).toEqual(['top', 'mid']);
  });

  it('filters out chunks with metadata.split = true', () => {
    const chunks = new Map<string, ContextChunk>([
      ['good', makeChunk({ id: 'good' })],
      ['split', makeChunk({ id: 'split', metadata: { split: true } })],
    ]);

    const retrieval = [
      makeResult('good', 0.9),
      makeResult('split', 0.8),
    ];

    const policy = makePolicy({ minKeep: 0, scoreThresholdRatio: 0 });
    const result = selectRetrievalCandidates(retrieval, chunks, policy);

    expect(result.ranked).toHaveLength(1);
    expect(result.ranked[0].chunkId).toBe('good');
    expect(result.dropped).toContainEqual({
      chunkId: 'split',
      reason: 'split parent metadata chunk',
    });
  });

  it('skips results with chunkId not in chunks map', () => {
    const chunks = new Map<string, ContextChunk>([
      ['a', makeChunk({ id: 'a' })],
    ]);

    const retrieval = [
      makeResult('a', 0.9),
      makeResult('missing', 0.8),
    ];

    const policy = makePolicy({ minKeep: 0, scoreThresholdRatio: 0 });
    const result = selectRetrievalCandidates(retrieval, chunks, policy);

    expect(result.ranked).toHaveLength(1);
    expect(result.ranked[0].chunkId).toBe('a');
    expect(result.dropped).toContainEqual({
      chunkId: 'missing',
      reason: 'chunk not found',
    });
  });

  it('uses source as fallback for path when path is undefined', () => {
    const chunks = new Map<string, ContextChunk>([
      ['a', makeChunk({ id: 'a', source: 'conv-1' })],
      ['b', makeChunk({ id: 'b', source: 'conv-1' })],
    ]);

    const retrieval = [
      makeResult('a', 0.9),
      makeResult('b', 0.8),
    ];

    const policy = makePolicy({ maxChunksPerPath: 1, minKeep: 0, scoreThresholdRatio: 0 });
    const result = selectRetrievalCandidates(retrieval, chunks, policy);

    // Both share source 'conv-1', so second should be capped
    expect(result.ranked).toHaveLength(1);
  });

  it('protected candidates bypass per-path cap', () => {
    const chunks = new Map<string, ContextChunk>([
      ['a', makeChunk({ id: 'a', path: 'src/core.ts' })],
      ['b', makeChunk({ id: 'b', path: 'src/core.ts' })],
      ['c', makeChunk({ id: 'c', path: 'src/core.ts' })],
      ['other', makeChunk({ id: 'other', path: 'src/util.ts' })],
    ]);

    const retrieval: RetrievalResult[] = [
      makeResult('a', 1.0),
      makeResult('b', 0.9),
      makeResult('c', 0.8),
      makeResult('other', 0.7),
    ];

    // minKeep=3 protects a, b, c from same path; maxChunksPerPath=2 would normally cap at 2
    const policy = makePolicy({ minKeep: 3, maxChunksPerPath: 2, scoreThresholdRatio: 0 });
    const result = selectRetrievalCandidates(retrieval, chunks, policy);

    // All 3 protected candidates from src/core.ts are included despite per-path cap
    expect(result.ranked.map((r) => r.chunkId)).toContain('a');
    expect(result.ranked.map((r) => r.chunkId)).toContain('b');
    expect(result.ranked.map((r) => r.chunkId)).toContain('c');
    expect(result.ranked.map((r) => r.chunkId)).toContain('other');
  });

  it('per-path cap drops non-protected candidates after protected set uses cap slots', () => {
    const chunks = new Map<string, ContextChunk>([
      ['a', makeChunk({ id: 'a', path: 'src/core.ts' })],
      ['b', makeChunk({ id: 'b', path: 'src/core.ts' })],
      ['c', makeChunk({ id: 'c', path: 'src/core.ts' })],
      ['d', makeChunk({ id: 'd', path: 'src/core.ts' })],
    ]);

    const retrieval: RetrievalResult[] = [
      makeResult('a', 1.0),
      makeResult('b', 0.9),
      makeResult('c', 0.8),
      makeResult('d', 0.7),
    ];

    // minKeep=2 protects a and b; maxChunksPerPath=2 means slots are full after protected set
    const policy = makePolicy({ minKeep: 2, maxChunksPerPath: 2, scoreThresholdRatio: 0 });
    const result = selectRetrievalCandidates(retrieval, chunks, policy);

    expect(result.ranked.map((r) => r.chunkId)).toContain('a');
    expect(result.ranked.map((r) => r.chunkId)).toContain('b');
    // c and d are beyond protected set and path already has 2 entries
    expect(result.dropped.some((d) => d.chunkId === 'c')).toBe(true);
    expect(result.dropped.some((d) => d.chunkId === 'd')).toBe(true);
    expect(result.dropped.find((d) => d.chunkId === 'c')?.reason).toContain('per-path');
  });
});

describe('budgetForSelectedCandidates', () => {
  it('returns hard budget for exhaustive mode', () => {
    const chunks = new Map<string, ContextChunk>();
    const policy = createRetrievalSelectionPolicy({
      mode: 'exhaustive',
      complexity: 'moderate',
      hardBudget: 100_000,
      requestedTopK: 10,
    });

    const budget = budgetForSelectedCandidates([], chunks, policy);
    expect(budget).toBe(100_000);
  });

  it('provides protected tokens as lower bound', () => {
    const chunks = new Map<string, ContextChunk>([
      ['a', makeChunk({ id: 'a', tokensEstimate: 5_000 })],
      ['b', makeChunk({ id: 'b', tokensEstimate: 3_000 })],
      ['c', makeChunk({ id: 'c', tokensEstimate: 2_000 })],
    ]);

    const policy = createRetrievalSelectionPolicy({
      mode: 'focused',
      complexity: 'narrow',
      hardBudget: 200_000,
      requestedTopK: 10,
    });

    const selected = [
      makeResult('a', 0.9),
      makeResult('b', 0.8),
      makeResult('c', 0.7),
    ];

    const budget = budgetForSelectedCandidates(selected, chunks, policy);
    // Protected tokens = sum of first minKeep=3 chunks = 5_000 + 3_000 + 2_000 = 10_000
    // targetBudget = FOCUSED_TARGETS.narrow = 6_000
    // Result = min(hardBudget, max(targetBudget, protectedTokens)) = min(200_000, max(6_000, 10_000)) = 10_000
    expect(budget).toBe(10_000);
  });

  it('respects target budget when larger than protected tokens', () => {
    const chunks = new Map<string, ContextChunk>([
      ['a', makeChunk({ id: 'a', tokensEstimate: 100 })],
    ]);

    const policy = createRetrievalSelectionPolicy({
      mode: 'focused',
      complexity: 'moderate',
      hardBudget: 200_000,
      requestedTopK: 10,
    });

    const selected = [makeResult('a', 0.9)];

    const budget = budgetForSelectedCandidates(selected, chunks, policy);
    // Protected tokens for first minKeep=3: only 1 result, so 100
    // targetBudget = 13_000
    // Result = min(200_000, max(13_000, 100)) = 13_000
    expect(budget).toBe(13_000);
  });

  it('caps at hard budget', () => {
    const chunks = new Map<string, ContextChunk>([
      ['a', makeChunk({ id: 'a', tokensEstimate: 100_000 })],
      ['b', makeChunk({ id: 'b', tokensEstimate: 100_000 })],
      ['c', makeChunk({ id: 'c', tokensEstimate: 100_000 })],
    ]);

    const policy = createRetrievalSelectionPolicy({
      mode: 'focused',
      complexity: 'broad',
      hardBudget: 10_000,
      requestedTopK: 10,
    });

    const selected = [
      makeResult('a', 0.9),
      makeResult('b', 0.8),
      makeResult('c', 0.7),
    ];

    const budget = budgetForSelectedCandidates(selected, chunks, policy);
    // Protected tokens = 300_000, but capped at hardBudget = 10_000
    expect(budget).toBe(10_000);
  });

  it('handles missing chunks gracefully', () => {
    const chunks = new Map<string, ContextChunk>();

    const policy = createRetrievalSelectionPolicy({
      mode: 'focused',
      complexity: 'moderate',
      hardBudget: 100_000,
      requestedTopK: 10,
    });

    const selected = [makeResult('missing', 0.9)];

    const budget = budgetForSelectedCandidates(selected, chunks, policy);
    // Protected tokens = 0 (missing chunk), so result = targetBudget = 13_000
    expect(budget).toBe(13_000);
  });
});
