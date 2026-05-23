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

function makeSymbol(
  chunk: ContextChunk,
  name: string,
  kind: CodeSymbol['kind'] = 'function'
): CodeSymbol {
  return {
    id: `${chunk.id}:${name}`,
    chunkId: chunk.id,
    path: chunk.path ?? '',
    language: 'typescript',
    name,
    normalizedName: name.toLowerCase().replace(/[^a-z0-9_$]/g, ''),
    kind,
    startLine: 1,
    endLine: 1,
    signature: name,
    isExported: true,
    metadata: {},
  };
}

function makeReference(chunk: ContextChunk, target: string): CodeReference {
  return {
    id: `${chunk.id}:${target}`,
    chunkId: chunk.id,
    path: chunk.path ?? '',
    language: 'typescript',
    target,
    normalizedTarget: target.toLowerCase().replace(/[^a-z0-9_$./:-]/g, ''),
    kind: 'export',
    startLine: 1,
    endLine: 1,
    metadata: {},
  };
}

function makeStorage(
  chunks: ContextChunk[],
  lexicalScores: Record<string, number>,
  symbols: Record<string, Array<string | { name: string; kind?: CodeSymbol['kind'] }>>,
  references: Record<string, string[]> = {}
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
      return (symbols[chunkId] ?? []).map((symbol) => {
        if (typeof symbol === 'string') return makeSymbol(chunk, symbol);
        return makeSymbol(chunk, symbol.name, symbol.kind);
      });
    },
    getCodeReferences: (chunkId: string): CodeReference[] => {
      const chunk = chunkMap.get(chunkId);
      if (!chunk) return [];
      return (references[chunkId] ?? []).map((target) => makeReference(chunk, target));
    },
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

  it('promotes provider contracts and barrel exports for provider implementation tasks', async () => {
    const chunks = [
      makeChunk('existing-provider', 'src/providers/deterministic-embedding.ts', 1_500),
      makeChunk('compression-provider', 'src/providers/llm-compression.ts', 1_400),
      makeChunk('provider-index', 'src/providers/index.ts', 500),
      makeChunk('types', 'src/types/index.ts', 800),
    ];
    const storage = makeStorage(
      chunks,
      {
        'existing-provider': 10,
        'compression-provider': 5,
        'provider-index': 5,
        types: 4,
      },
      {
        'existing-provider': ['DeterministicEmbeddingProvider', 'embed'],
        'compression-provider': ['LLMCompressionProvider'],
        types: [{ name: 'EmbeddingProvider', kind: 'interface' }],
      },
      {
        'provider-index': [
          './deterministic-embedding.js',
          './local-embedding.js',
          './gpu-embedding.js',
        ],
      }
    );
    const retriever = new HybridRetriever(storage as any, new DeterministicEmbeddingProvider());

    const results = await retriever.retrieve(
      'Add a new embedding provider that uses OpenAI embeddings',
      { strategy: 'structural', topK: 10 }
    );
    const rankedIds = results.map((result) => result.chunkId);

    expect(rankedIds.indexOf('types')).toBeLessThan(rankedIds.indexOf('compression-provider'));
    expect(rankedIds.indexOf('provider-index')).toBeLessThan(rankedIds.indexOf('compression-provider'));
    expect(results.find((result) => result.chunkId === 'types')?.reasons).toContain(
      'sparse contract exact: EmbeddingProvider'
    );
    expect(results.find((result) => result.chunkId === 'provider-index')?.reasons).toContain(
      'sparse module index segment: providers'
    );
  });

  it('ranks reranker provider contracts above broad lexical retrieval overlap', async () => {
    const chunks = [
      makeChunk('vector-index', 'src/storage/vector-index.ts', 1_000),
      makeChunk('types', 'src/types/index.ts', 800),
      makeChunk('reranker', 'src/providers/deterministic-reranker.ts', 700),
    ];
    const storage = makeStorage(
      chunks,
      {
        'vector-index': 4,
        types: 0,
        reranker: 0,
      },
      {
        types: [{ name: 'RerankerProvider', kind: 'interface' }],
        reranker: ['DeterministicRerankerProvider'],
      }
    );
    const retriever = new HybridRetriever(storage as any, new DeterministicEmbeddingProvider());

    const results = await retriever.retrieve(
      'Add a reranking step after hybrid retrieval using a cross-encoder',
      { strategy: 'structural', topK: 10 }
    );
    const rankedIds = results.map((result) => result.chunkId);

    expect(rankedIds.indexOf('types')).toBeLessThan(rankedIds.indexOf('vector-index'));
    const typeResult = results.find((result) => result.chunkId === 'types');
    expect(typeResult?.sourceScores).toEqual({
      structural: expect.any(Number),
      vector: 0,
      fts: 0,
      graph: 0,
      dependency: 0,
      final: expect.any(Number),
    });
    expect(typeResult?.sourceScores?.structural).toBeGreaterThan(4);
    expect(typeResult?.reasons).toContain('sparse contract exact: RerankerProvider');
  });

  it('promotes scoring and routing modules for auth/login debug misses over lexical noise', async () => {
    const chunks = [
      makeChunk('retriever', 'src/core/retriever.ts', 1_000),
      makeChunk('budget', 'src/core/budget.ts', 800),
      makeChunk('scorer', 'src/core/scorer.ts', 900),
      makeChunk('router', 'src/core/router.ts', 900),
    ];
    const storage = makeStorage(
      chunks,
      {
        retriever: 4,
        budget: 2,
      },
      {
        scorer: ['ContextScorer', 'scoreChunks'],
        router: ['ContextRouter', 'route'],
      }
    );
    const retriever = new HybridRetriever(storage as any, new DeterministicEmbeddingProvider());

    const results = await retriever.retrieve(
      'Fix the authentication bug causing 401 errors in the login flow',
      { strategy: 'structural', topK: 10 }
    );
    const rankedIds = results.map((result) => result.chunkId);

    expect(rankedIds.indexOf('scorer')).toBeLessThan(rankedIds.indexOf('retriever'));
    expect(rankedIds.indexOf('router')).toBeLessThan(rankedIds.indexOf('retriever'));
    expect(results.find((result) => result.chunkId === 'scorer')?.reasons).toContain(
      'path intent filename match: scorer'
    );
    expect(results.find((result) => result.chunkId === 'router')?.reasons).toContain(
      'path intent filename match: router'
    );
  });
});
