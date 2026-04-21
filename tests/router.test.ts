import { describe, it, expect } from 'vitest';
import { ContextRouter, DEFAULT_ROUTING_CONFIG } from '../src/core/router.js';
import type { ContextChunk, DependencyLink } from '../src/types/index.js';

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

describe('ContextRouter', () => {
  const router = new ContextRouter(DEFAULT_ROUTING_CONFIG);

  it('routes high-score chunks to hot', () => {
    const chunks = [makeChunk({ id: 'high', type: 'fact' })];
    const scores = { high: 0.85 };
    const reasons = { high: ['high score'] };

    const result = router.route(scores, reasons, chunks, []);
    expect(result.hot).toContain('high');
  });

  it('routes medium-score chunks to warm', () => {
    const chunks = [makeChunk({ id: 'medium', type: 'fact' })];
    const scores = { medium: 0.55 };
    const reasons = { medium: ['medium score'] };

    const result = router.route(scores, reasons, chunks, []);
    expect(result.warm).toContain('medium');
  });

  it('routes low-score chunks to cold', () => {
    const chunks = [makeChunk({ id: 'low', type: 'fact' })];
    const scores = { low: 0.1 };
    const reasons = { low: ['low score'] };

    const result = router.route(scores, reasons, chunks, []);
    expect(result.cold).toContain('low');
  });

  it('promotes constraint chunks with score > 0.3 to hot', () => {
    const chunks = [makeChunk({ id: 'con', type: 'constraint' })];
    const scores = { con: 0.35 };
    const reasons = { con: ['constraint'] };

    const result = router.route(scores, reasons, chunks, []);
    expect(result.hot).toContain('con');
  });

  it('promotes instruction chunks with score > 0.5 to hot', () => {
    const chunks = [makeChunk({ id: 'instr', type: 'instruction' })];
    const scores = { instr: 0.55 };
    const reasons = { instr: ['instruction'] };

    const result = router.route(scores, reasons, chunks, []);
    expect(result.hot).toContain('instr');
  });

  it('demotes redundant hot chunks to warm', () => {
    const chunks = [makeChunk({ id: 'red', type: 'fact' })];
    const scores = { red: 0.85 };
    const reasons = { red: ['redundant with chunk abc'] };

    const result = router.route(scores, reasons, chunks, []);
    expect(result.warm).toContain('red');
  });

  it('promotes warm dependencies of hot chunks via closure', () => {
    // Need enough chunks that promoting warm-dep doesn't exceed 60% hot cap
    const chunks = [
      makeChunk({ id: 'hot-1', type: 'code' }),
      makeChunk({ id: 'warm-dep', type: 'code' }),
      makeChunk({ id: 'cold-1', type: 'fact' }),
      makeChunk({ id: 'cold-2', type: 'background' }),
    ];
    const scores = { 'hot-1': 0.8, 'warm-dep': 0.5, 'cold-1': 0.1, 'cold-2': 0.05 };
    const reasons = { 'hot-1': ['high'], 'warm-dep': ['medium'], 'cold-1': ['low'], 'cold-2': ['low'] };
    const deps: DependencyLink[] = [
      { fromId: 'hot-1', toId: 'warm-dep', type: 'references', weight: 0.7 },
    ];

    const result = router.route(scores, reasons, chunks, deps);
    expect(result.hot).toContain('hot-1');
    expect(result.hot).toContain('warm-dep'); // promoted: 2/4 = 50% < 60% cap
  });

  it('places all chunks in exactly one tier', () => {
    // Need enough chunks for constraint promotion to stay under 60% cap
    const chunks = [
      makeChunk({ id: 'a', type: 'fact' }),
      makeChunk({ id: 'b', type: 'constraint' }),
      makeChunk({ id: 'c', type: 'code' }),
      makeChunk({ id: 'd', type: 'background' }),
      makeChunk({ id: 'e', type: 'log' }),
    ];
    const scores = { a: 0.8, b: 0.35, c: 0.1, d: 0.05, e: 0.02 };
    const reasons = { a: [], b: [], c: [], d: [], e: [] };

    const result = router.route(scores, reasons, chunks, []);
    const allIds = [...result.hot, ...result.warm, ...result.cold];
    expect(allIds).toHaveLength(5);
    expect(result.hot).toContain('a');
    expect(result.hot).toContain('b'); // promoted constraint (2/5 = 40% < 60%)
    expect(result.cold).toContain('c');
  });

  it('has correct default config structure', () => {
    expect(DEFAULT_ROUTING_CONFIG.weights.semantic).toBe(0.3);
    expect(DEFAULT_ROUTING_CONFIG.weights.constraint).toBe(0.25);
    expect(DEFAULT_ROUTING_CONFIG.thresholds.hot).toBe(0.7);
    expect(DEFAULT_ROUTING_CONFIG.thresholds.warm).toBe(0.4);
  });
});
