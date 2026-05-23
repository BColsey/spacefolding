import { describe, expect, it } from 'vitest';
import { HybridRetriever } from '../src/core/retriever.js';
import {
  budgetForSelectedCandidates,
  createRetrievalSelectionPolicy,
  selectRetrievalCandidates,
} from '../src/core/retrieval-policy.js';
import { fillBudget } from '../src/core/budget.js';
import { DeterministicEmbeddingProvider } from '../src/providers/deterministic-embedding.js';
import type { CodeReference, CodeSymbol, ContextChunk } from '../src/types/index.js';

function makeChunk(id: string, path: string, tokensEstimate: number): ContextChunk {
  return {
    id,
    source: 'test',
    type: 'code',
    text: `${path} ${id}`,
    timestamp: Date.now(),
    path,
    tokensEstimate,
    childrenIds: [],
    metadata: {},
  };
}

function makeSymbol(chunk: ContextChunk, name: string): CodeSymbol {
  return {
    id: `${chunk.id}:${name}`,
    chunkId: chunk.id,
    path: chunk.path ?? '',
    language: 'typescript',
    name,
    normalizedName: name.toLowerCase().replace(/[^a-z0-9_$]/g, ''),
    kind: 'function',
    startLine: 1,
    endLine: 1,
    signature: name,
    isExported: true,
    metadata: {},
  };
}

function makeStorage(
  chunks: ContextChunk[],
  lexicalScores: Record<string, number>,
  symbols: Record<string, string[]>
) {
  const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  return {
    getChunk: (id: string) => chunkMap.get(id) ?? null,
    getAllChunks: () => chunks,
    getDependencies: () => [],
    searchByLexical: () => chunks
      .map((chunk) => ({ chunkId: chunk.id, score: lexicalScores[chunk.id] ?? 0 }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score),
    searchByText: () => [],
    searchByStructure: () => [],
    getCodeSymbols: (chunkId: string): CodeSymbol[] => {
      const chunk = chunkMap.get(chunkId);
      if (!chunk) return [];
      return (symbols[chunkId] ?? []).map((name) => makeSymbol(chunk, name));
    },
    getCodeReferences: (): CodeReference[] => [],
  };
}

describe('HybridRetriever structural ranking', () => {
  it('keeps repository candidates inside focused budget for batch delete implementation tasks', async () => {
    const chunks = [
      makeChunk('mcp-a', 'src/mcp/server.ts', 2_521),
      makeChunk('mcp-b', 'src/mcp/server.ts', 2_335),
      makeChunk('mcp-c', 'src/mcp/server.ts', 1_317),
      makeChunk('orchestrator', 'src/pipeline/orchestrator.ts', 3_005),
      makeChunk('types', 'src/types/index.ts', 1_610),
      makeChunk('chunker', 'src/core/chunker.ts', 2_403),
      makeChunk('repository', 'src/storage/repository.ts', 2_825),
    ];
    const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const storage = makeStorage(
      chunks,
      {
        'mcp-a': 14,
        'mcp-b': 12,
        'mcp-c': 10,
        orchestrator: 16,
        types: 16,
        chunker: 15,
        repository: 12,
      },
      {
        'mcp-a': ['TOOL_DEFINITIONS'],
        'mcp-b': ['server'],
        'mcp-c': ['deleteChunk'],
        orchestrator: ['deleteChunks'],
        types: ['ContextChunk', 'ContextFilter'],
        chunker: ['chunks', 'ChunkingConfig'],
        repository: ['deleteChunk', 'queryChunks', 'storeChunk'],
      }
    );
    const retriever = new HybridRetriever(
      storage as any,
      new DeterministicEmbeddingProvider()
    );

    const results = await retriever.retrieve(
      'Add a new MCP tool for batch deleting chunks by source or path pattern, so users can clean up stale context without deleting one chunk at a time.',
      { strategy: 'structural', topK: 10 }
    );
    const rankedIds = results.map((result) => result.chunkId);

    expect(rankedIds.indexOf('repository')).toBeGreaterThanOrEqual(0);
    expect(rankedIds.indexOf('repository')).toBeLessThan(rankedIds.indexOf('chunker'));
    expect(results.find((result) => result.chunkId === 'repository')?.reasons).toContain(
      'path intent segment match: storage'
    );

    const policy = createRetrievalSelectionPolicy({
      complexity: 'moderate',
      hardBudget: 50_000,
      requestedTopK: 10,
    });
    const selected = selectRetrievalCandidates(results, chunkMap, policy);
    const effectiveBudget = budgetForSelectedCandidates(selected.ranked, chunkMap, selected.policy);
    const filled = fillBudget(selected.ranked, chunkMap, effectiveBudget, {
      collapseSiblings: true,
    });

    expect(effectiveBudget).toBe(13_000);
    expect(filled.totalTokens).toBeLessThanOrEqual(effectiveBudget);
    expect(filled.selected.map((chunk) => chunk.path)).toContain('src/storage/repository.ts');
  });
});
