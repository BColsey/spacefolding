import { describe, expect, it } from 'vitest';
import { CrossEncoderRerankerProvider } from '../src/providers/cross-encoder-reranker.js';

describe('CrossEncoderRerankerProvider', () => {
  it('offline fallback reranks by jaccard overlap and matches RerankerProvider shape', async () => {
    const reranker = new CrossEncoderRerankerProvider({ useDeterministicFallback: true });
    const out = await reranker.rerank('authentication middleware', [
      'nothing relevant here',
      'authentication middleware checks tokens',
    ]);
    expect(out).toHaveLength(2);
    for (const r of out) {
      expect(typeof r.index).toBe('number');
      expect(typeof r.score).toBe('number');
      expect(typeof r.reason).toBe('string');
      expect(Number.isFinite(r.score)).toBe(true);
    }
    // sorted desc by score
    expect(out[0].score).toBeGreaterThanOrEqual(out[1].score);
    // the doc with both query words wins
    expect(out[0].index).toBe(1);
  });

  it('caps returned candidates at topK', async () => {
    const reranker = new CrossEncoderRerankerProvider({ useDeterministicFallback: true, topK: 1 });
    const out = await reranker.rerank('alpha', ['alpha beta', 'gamma delta', 'alpha gamma']);
    expect(out).toHaveLength(1);
  });
});
