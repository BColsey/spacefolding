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

  it('keeps a byte-identical stable prefix across inputs that share chunks but differ in query/scores/utilization (cache-aware)', () => {
    const sharedChunks = [makeChunk()];
    const sharedTiers = new Map([['chunk-1', 'warm']]);

    const baseInput = {
      chunks: sharedChunks,
      tiers: sharedTiers,
      budget: 1000,
      hardBudget: 1000,
      targetBudget: 500,
    };

    const packA = formatContextPack({
      ...baseInput,
      query: 'where is targetContextPack',
      totalTokens: 42,
      utilization: 0.042,
      omitted: [{ chunkId: 'chunk-2', tokensEstimate: 900, reason: 'exceeds remaining budget' }],
      dropped: [{ chunkId: 'chunk-3', reason: 'below focused score threshold' }],
      plan: { intent: 'explain', strategy: 'structural', maxHops: 0 },
      retrieval: [{
        chunkId: 'chunk-1',
        score: 12,
        sources: ['structural', 'fts'],
        reasons: ['symbol match: targetContextPack', 'scores final=12.000'],
        sourceScores: { structural: 10, fts: 2, vector: 0, graph: 0, dependency: 0, final: 12 },
      }],
      selectionPolicy: { mode: 'focused', effectiveBudget: 500, selectedCandidates: 1, droppedCandidates: 1 },
    });

    const packB = formatContextPack({
      ...baseInput,
      query: 'a completely different query string',
      totalTokens: 999,
      utilization: 0.876,
      omitted: [{ chunkId: 'chunk-9', tokensEstimate: 7, reason: 'a different omission reason' }],
      dropped: [{ chunkId: 'chunk-8', reason: 'a different drop reason' }],
      plan: { intent: 'locate', strategy: 'text', maxHops: 3 },
      retrieval: [{
        chunkId: 'chunk-1',
        score: 99,
        sources: ['vector'],
        reasons: ['semantic match'],
        sourceScores: { structural: 0, fts: 0, vector: 88, graph: 0, dependency: 0, final: 99 },
      }],
      selectionPolicy: { mode: 'broad', effectiveBudget: 500, selectedCandidates: 5, droppedCandidates: 9 },
    });

    const delimiter = '## Query Metadata';
    const prefixA = packA.slice(0, packA.indexOf(delimiter));
    const prefixB = packB.slice(0, packB.indexOf(delimiter));

    // The whole point of Q1a: a prompt-cacheable, byte-identical stable prefix.
    expect(prefixA).toBe(prefixB);

    // Guard: the prefix must actually contain the stable instructional content
    // (so the test cannot pass by emitting an empty prefix).
    expect(prefixA).toContain('# Spacefolding Context Pack');
    expect(prefixA).toContain('## How To Use This Pack');
    expect(prefixA).toContain('## Selected Context');
    expect(prefixA).toContain('### 1. src/context-pack.ts [warm]');
    expect(prefixA).toContain('export function targetContextPack()');

    // Guard: volatile values must still exist, but only in the trailer.
    const trailerA = packA.slice(packA.indexOf(delimiter));
    const trailerB = packB.slice(packB.indexOf(delimiter));
    expect(trailerA).toContain('Query: where is targetContextPack');
    expect(trailerA).toContain('Tokens: 42/500 target (1000 hard cap, 4% used)');
    expect(trailerA).toContain('Candidates: 1 selected, 1 dropped');
    expect(trailerA).toContain('Scores: final=12.000');
    expect(trailerB).toContain('Query: a completely different query string');
    expect(trailerB).toContain('Tokens: 999/500 target (1000 hard cap, 88% used)');
    expect(trailerB).toContain('Candidates: 5 selected, 9 dropped');
    expect(trailerB).toContain('Scores: final=99.000');
  });
});
