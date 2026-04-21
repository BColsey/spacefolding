import { describe, it, expect } from 'vitest';
import { ContextScorer } from '../src/core/scorer.js';
import { DEFAULT_ROUTING_CONFIG } from '../src/core/router.js';
import { DeterministicTokenEstimator } from '../src/providers/token-estimator.js';
import { DeterministicEmbeddingProvider } from '../src/providers/deterministic-embedding.js';
import type { ContextChunk } from '../src/types/index.js';

function makeChunk(overrides: Partial<ContextChunk> & { id: string }): ContextChunk {
  return {
    source: 'test',
    type: 'fact',
    text: 'test text',
    timestamp: Date.now(),
    tokensEstimate: 10,
    childrenIds: [],
    metadata: {},
    ...overrides,
  };
}

describe('ContextScorer', () => {
  const scorer = new ContextScorer(
    DEFAULT_ROUTING_CONFIG,
    new DeterministicEmbeddingProvider(),
    new DeterministicTokenEstimator()
  );

  it('scores constraint chunks higher than background', async () => {
    const task = { text: 'Fix authentication bug' };
    const chunks = [
      makeChunk({ id: 'constraint-1', type: 'constraint', text: 'Must use JWT for authentication' }),
      makeChunk({ id: 'background-1', type: 'background', text: 'The project was started in 2020' }),
    ];

    const { scores } = await scorer.scoreChunks(task, chunks);
    expect(scores['constraint-1']).toBeGreaterThan(scores['background-1']);
  });

  it('gives non-zero score to a single chunk', async () => {
    const task = { text: 'Test task' };
    const chunks = [makeChunk({ id: 'single-1', text: 'Some test content' })];

    const { scores } = await scorer.scoreChunks(task, chunks);
    expect(scores['single-1']).toBeGreaterThan(0);
  });

  it('returns all scores between 0 and 1', async () => {
    const task = { text: 'Test task' };
    const chunks = [
      makeChunk({ id: 'a', type: 'constraint', text: 'Must do X' }),
      makeChunk({ id: 'b', type: 'code', text: 'function x() {}' }),
      makeChunk({ id: 'c', type: 'log', text: '2024-01-01 INFO something' }),
    ];

    const { scores } = await scorer.scoreChunks(task, chunks);
    for (const score of Object.values(scores)) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('penalizes redundant chunks', async () => {
    const task = { text: 'Test task' };
    const identicalText = 'This is exactly the same content repeated';
    const chunks = [
      makeChunk({ id: 'original', text: identicalText }),
      makeChunk({ id: 'duplicate', text: identicalText }),
    ];

    const { scores, reasons } = await scorer.scoreChunks(task, chunks);
    // At least one should have a redundancy penalty in its reasons
    const hasRedundancy = Object.values(reasons).some((rs) =>
      rs.some((r) => r.includes('redundant'))
    );
    expect(hasRedundancy).toBe(true);
  });

  it('returns empty scores for empty chunks', async () => {
    const task = { text: 'Test task' };
    const { scores } = await scorer.scoreChunks(task, []);
    expect(Object.keys(scores)).toHaveLength(0);
  });

  it('uses configured weights in scoring', async () => {
    const task = { text: 'Fix the authentication bug in login.ts' };
    const chunks = [
      makeChunk({ id: 'recent-code', type: 'code', text: 'function authenticate() { return false; }', timestamp: Date.now() }),
      makeChunk({ id: 'old-code', type: 'code', text: 'function authenticate() { return false; }', timestamp: Date.now() - 7 * 24 * 60 * 60 * 1000 * 30 }), // 30 days old
    ];

    const { scores } = await scorer.scoreChunks(task, chunks);
    // Recent chunk should score higher due to recency weight
    expect(scores['recent-code']).toBeGreaterThan(scores['old-code']);
  });
});
