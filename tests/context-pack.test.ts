import { describe, expect, it } from 'vitest';
import { formatContextPack } from '../src/core/context-pack.js';
import type { ContextChunk } from '../src/types/index.js';

function makeChunk(overrides: Partial<ContextChunk> = {}): ContextChunk {
  return {
    id: 'chunk-1',
    source: 'file',
    type: 'code',
    text: 'export function targetContextPack() { return true; }',
    timestamp: 1,
    path: 'src/context-pack.ts',
    language: 'typescript',
    tokensEstimate: 42,
    childrenIds: [],
    metadata: {},
    ...overrides,
  };
}

describe('formatContextPack', () => {
  it('formats selected chunks, retrieval reasons, budget metadata, and diagnostics', () => {
    const pack = formatContextPack({
      query: 'where is targetContextPack',
      chunks: [makeChunk()],
      tiers: new Map([['chunk-1', 'warm']]),
      totalTokens: 42,
      budget: 1000,
      hardBudget: 1000,
      targetBudget: 500,
      utilization: 0.042,
      omitted: [{ chunkId: 'chunk-2', tokensEstimate: 900, reason: 'exceeds remaining budget' }],
      dropped: [{ chunkId: 'chunk-3', reason: 'below focused score threshold' }],
      plan: { intent: 'explain', strategy: 'structural', maxHops: 0 },
      retrieval: [{
        chunkId: 'chunk-1',
        score: 12,
        sources: ['structural', 'fts'],
        reasons: ['symbol match: targetContextPack', 'scores final=12.000'],
        sourceScores: {
          structural: 10,
          fts: 2,
          vector: 0,
          graph: 0,
          dependency: 0,
          final: 12,
        },
      }],
      selectionPolicy: {
        mode: 'focused',
        effectiveBudget: 500,
        selectedCandidates: 1,
        droppedCandidates: 1,
      },
    });

    expect(pack).toContain('# Spacefolding Context Pack');
    expect(pack).toContain('Query: where is targetContextPack');
    expect(pack).toContain('Intent: explain | Strategy: structural | Mode: focused');
    expect(pack).toContain('Tokens: 42/500 target (1000 hard cap, 4% used)');
    expect(pack).toContain('### 1. src/context-pack.ts [warm]');
    expect(pack).toContain('- Sources: structural+fts');
    expect(pack).toContain('- Scores: final=12.000 structural=10.000');
    expect(pack).toContain('- Why: symbol match: targetContextPack');
    expect(pack).toContain('~~~typescript');
    expect(pack).toContain('export function targetContextPack()');
    expect(pack).toContain('## Omitted By Budget');
    expect(pack).toContain('`chunk-2` (900 tokens): exceeds remaining budget');
    expect(pack).toContain('## Dropped Candidate Diagnostics');
    expect(pack).toContain('`chunk-3`: below focused score threshold');
  });
});
