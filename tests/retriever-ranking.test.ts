import { describe, expect, it, vi } from 'vitest';
import { HybridRetriever } from '../src/core/retriever.js';
import {
  budgetForSelectedCandidates,
  createRetrievalSelectionPolicy,
  selectRetrievalCandidates,
} from '../src/core/retrieval-policy.js';
import { fillBudget } from '../src/core/budget.js';
import { DeterministicEmbeddingProvider } from '../src/providers/deterministic-embedding.js';
import type {
  CodeReference,
  CodeSymbol,
  ContextChunk,
  EmbeddingProvider,
  RerankerProvider,
  StructuralSearchResult,
} from '../src/types/index.js';

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

function makeStructuralResult(
  chunkId: string,
  structuralScore: number,
  dependencyBoost: number,
  reasons: string[]
): StructuralSearchResult {
  return {
    chunkId,
    score: structuralScore + dependencyBoost,
    structuralScore,
    dependencyBoost,
    reasons,
  };
}

class ReliableEmbeddingProvider implements EmbeddingProvider {
  async embed(): Promise<number[]> {
    return [1, 0, 0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0]);
  }
}

describe('HybridRetriever structural ranking', () => {
  it('ranks exact path matches first despite broad lexical overlap', async () => {
    const chunks = [
      makeChunk('exact', 'src/core/retriever.ts', 900),
      makeChunk('same-filename', 'src/legacy/retriever.ts', 900),
      makeChunk('lexical-noise', 'src/core/retrieval-policy.ts', 900),
    ];
    const storage = {
      ...makeStorage(
        chunks,
        {
          exact: 2,
          'same-filename': 6,
          'lexical-noise': 250,
        },
        {}
      ),
      searchByStructure: () => [
        makeStructuralResult('exact', 3.2, 0, ['path exact match: src/core/retriever.ts']),
        makeStructuralResult('same-filename', 1.8, 0, ['path exact match: retriever.ts']),
      ],
    };
    const retriever = new HybridRetriever(storage as any, new DeterministicEmbeddingProvider());

    const results = await retriever.retrieve('src/core/retriever.ts', {
      strategy: 'structural',
      topK: 5,
    });

    expect(results[0].chunkId).toBe('exact');
    expect(results[0].reasons).toContain('path exact match: src/core/retriever.ts');
    expect(results[0].sourceScores?.structural).toBeGreaterThan(results[0].sourceScores?.fts ?? 0);
  });

  it('keeps exact symbol matches ahead of lexical and deterministic vector noise', async () => {
    const chunks = [
      makeChunk('repository', 'src/storage/repository.ts', 1_200),
      makeChunk('lexical-noise', 'docs/sqlite-notes.md', 1_000),
      makeChunk('vector-noise', 'src/unrelated/vector.ts', 800),
    ];
    const searchByVector = vi.fn(() => [{ chunkId: 'vector-noise', score: 999 }]);
    const storage = {
      ...makeStorage(
        chunks,
        {
          repository: 2,
          'lexical-noise': 300,
        },
        {
          repository: [{ name: 'SQLiteRepository', kind: 'class' }],
        }
      ),
      searchByStructure: () => [
        makeStructuralResult('repository', 3.4, 0, ['symbol exact match: SQLiteRepository']),
      ],
      searchByVector,
    };
    const retriever = new HybridRetriever(storage as any, new DeterministicEmbeddingProvider());

    const results = await retriever.retrieve('where is SQLiteRepository defined', {
      strategy: 'structural',
      topK: 5,
    });

    expect(results[0].chunkId).toBe('repository');
    expect(results[0].reasons).toContain('symbol exact match: SQLiteRepository');
    expect(searchByVector).not.toHaveBeenCalled();
  });

  it('reports structural, vector, fts, dependency, graph, and final source scores', async () => {
    const chunks = [
      makeChunk('combo', 'src/core/retriever.ts', 900),
    ];
    const storage = {
      ...makeStorage(chunks, {}, {}),
      searchByStructure: () => [
        makeStructuralResult('combo', 3.4, 0.1, [
          'symbol exact match: HybridRetriever',
          'direct reference exact match: QueryPlan',
        ]),
      ],
      searchByVector: () => [{ chunkId: 'combo', score: 0.9 }],
      searchByText: () => [{ chunkId: 'combo', score: 4 }],
      searchByLexical: () => [{ chunkId: 'combo', score: 3 }],
    };
    const retriever = new HybridRetriever(storage as any, new ReliableEmbeddingProvider());

    const results = await retriever.retrieve('HybridRetriever QueryPlan', {
      strategy: 'structural',
      topK: 5,
    });

    expect(results[0].sourceScores).toEqual({
      structural: expect.any(Number),
      vector: expect.any(Number),
      fts: expect.any(Number),
      graph: 0,
      dependency: expect.any(Number),
      final: expect.any(Number),
    });
    expect(results[0].sourceScores?.structural).toBeGreaterThan(0);
    expect(results[0].sourceScores?.vector).toBeGreaterThan(0);
    expect(results[0].sourceScores?.fts).toBeGreaterThan(0);
    expect(results[0].sourceScores?.dependency).toBeGreaterThan(0);
    expect(results[0].sourceScores?.final).toBe(results[0].score);
  });

  it('includes score breakdown in reasons', async () => {
    const chunks = [
      makeChunk('combo', 'src/core/retriever.ts', 900),
    ];
    const storage = {
      ...makeStorage(chunks, {}, {}),
      searchByStructure: () => [
        makeStructuralResult('combo', 3.4, 0, ['symbol exact match: HybridRetriever']),
      ],
      searchByVector: () => [{ chunkId: 'combo', score: 0.9 }],
      searchByText: () => [{ chunkId: 'combo', score: 4 }],
      searchByLexical: () => [{ chunkId: 'combo', score: 3 }],
    };
    const retriever = new HybridRetriever(storage as any, new ReliableEmbeddingProvider());

    const results = await retriever.retrieve('HybridRetriever', {
      strategy: 'structural',
      topK: 5,
    });

    const reasonStrings = results[0].reasons;
    const scoreBreakdown = reasonStrings.find((r) => r.startsWith('scores '));
    expect(scoreBreakdown).toBeDefined();
    expect(scoreBreakdown!).toMatch(/structural=\d+\.\d{3}/);
    expect(scoreBreakdown!).toMatch(/vector=\d+\.\d{3}/);
    expect(scoreBreakdown!).toMatch(/fts=\d+\.\d{3}/);
    expect(scoreBreakdown!).toMatch(/graph=\d+\.\d{3}/);
    expect(scoreBreakdown!).toMatch(/dependency=\d+\.\d{3}/);
    expect(scoreBreakdown!).toMatch(/final=\d+\.\d{3}/);
  });

  it('reports reranked final scores consistently with result ordering', async () => {
    const chunks = [
      makeChunk('a', 'src/auth/session.ts', 900),
      makeChunk('b', 'src/auth/middleware.ts', 900),
      makeChunk('c', 'src/auth/types.ts', 900),
    ];
    const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const storage = {
      getChunk: (id: string) => chunkMap.get(id) ?? null,
      getAllChunks: () => chunks,
      getDependencies: () => [],
      searchByStructure: () => [],
      searchByText: () => [],
      searchByVector: () => [
        { chunkId: 'a', score: 1 },
        { chunkId: 'b', score: 0.9 },
        { chunkId: 'c', score: 0 },
      ],
    };
    const reranker: RerankerProvider = {
      async rerank() {
        return [
          { index: 0, score: 0, reason: 'no keyword overlap' },
          { index: 1, score: 1, reason: 'direct keyword match' },
        ];
      },
    };
    const retriever = new HybridRetriever(storage as any, new ReliableEmbeddingProvider(), reranker);

    const results = await retriever.retrieve('authentication middleware', {
      strategy: 'hybrid',
      topK: 10,
    });

    expect(results.slice(0, 2).map((result) => result.chunkId)).toEqual(['b', 'a']);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[0].sourceScores?.final).toBe(results[0].score);
    expect(results[0].reasons).toContain('reranker direct keyword match: 1.000');
    expect(results[0].reasons.find((reason) => reason.startsWith('scores '))).toContain(
      `final=${results[0].score.toFixed(3)}`
    );
  });

  it('keeps graph traversal disabled for hybrid retrieval by default', async () => {
    const chunks = [
      makeChunk('seed', 'src/core/retriever.ts', 900),
      makeChunk('neighbor', 'src/core/budget.ts', 900),
    ];
    const getDependencies = vi.fn(() => [
      {
        id: 'dep-1',
        fromId: 'seed',
        toId: 'neighbor',
        type: 'imports',
        strength: 1,
        metadata: {},
      },
    ]);
    const storage = {
      ...makeStorage(chunks, {}, {}),
      getDependencies,
      searchByVector: () => [{ chunkId: 'seed', score: 0.9 }],
      searchByText: () => [{ chunkId: 'seed', score: 4 }],
      searchByLexical: () => [],
    };
    const retriever = new HybridRetriever(storage as any, new ReliableEmbeddingProvider());

    const results = await retriever.retrieve('retrieve budget dependencies', {
      strategy: 'hybrid',
      topK: 10,
    });

    expect(getDependencies).not.toHaveBeenCalled();
    expect(results.map((result) => result.chunkId)).toEqual(['seed']);
    expect(results[0].sources).not.toContain('graph');
    expect(results[0].sourceScores?.graph).toBe(0);
  });

  it('uses graph traversal for hybrid retrieval when maxHops is explicit', async () => {
    const chunks = [
      makeChunk('seed', 'src/core/retriever.ts', 900),
      makeChunk('neighbor', 'src/core/budget.ts', 900),
    ];
    const getDependencies = vi.fn((chunkId: string) => chunkId === 'seed'
      ? [
          {
            id: 'dep-1',
            fromId: 'seed',
            toId: 'neighbor',
            type: 'imports',
            strength: 1,
            metadata: {},
          },
        ]
      : []);
    const storage = {
      ...makeStorage(chunks, {}, {}),
      getDependencies,
      searchByVector: () => [{ chunkId: 'seed', score: 0.9 }],
      searchByText: () => [{ chunkId: 'seed', score: 4 }],
      searchByLexical: () => [],
    };
    const retriever = new HybridRetriever(storage as any, new ReliableEmbeddingProvider());

    const results = await retriever.retrieve('retrieve budget dependencies', {
      strategy: 'hybrid',
      maxHops: 1,
      topK: 10,
    });
    const graphResult = results.find((result) => result.chunkId === 'neighbor');

    expect(getDependencies).toHaveBeenCalledWith('seed');
    expect(graphResult?.sources).toContain('graph');
    expect(graphResult?.sourceScores?.graph).toBeGreaterThan(0);
    expect(graphResult?.reasons).toContain('dependency graph traversal');
  });

  it('uses graph traversal for graph strategy from recent chunks by default', async () => {
    const chunks = Array.from({ length: 12 }, (_, index) =>
      makeChunk(`chunk-${index}`, `src/module-${index}.ts`, 900)
    );
    const getDependencies = vi.fn((chunkId: string) => chunkId === 'chunk-11'
      ? [
          {
            id: 'dep-graph',
            fromId: 'chunk-11',
            toId: 'chunk-0',
            type: 'imports',
            strength: 1,
            metadata: {},
          },
        ]
      : []);
    const storage = {
      ...makeStorage(chunks, {}, {}),
      getDependencies,
      searchByVector: () => [],
      searchByText: () => [],
      searchByLexical: () => [],
    };
    const retriever = new HybridRetriever(storage as any, new ReliableEmbeddingProvider());

    const results = await retriever.retrieve('dependency graph', {
      strategy: 'graph',
      topK: 5,
    });

    expect(getDependencies).toHaveBeenCalledWith('chunk-11');
    expect(results.map((result) => result.chunkId)).toEqual(['chunk-0']);
    expect(results[0].sources).toEqual(['graph']);
    expect(results[0].sourceScores?.graph).toBeGreaterThan(0);
    expect(results[0].sourceScores?.final).toBe(results[0].score);
    expect(results[0].reasons).toContain('dependency graph traversal');
  });

  it('falls back to vector and text sources when structural lookup fails', async () => {
    const chunks = [
      makeChunk('vector-match', 'src/auth/session.ts', 900),
      makeChunk('text-match', 'src/auth/login.ts', 900),
    ];
    const storage = {
      ...makeStorage(chunks, {}, {}),
      searchByStructure: () => {
        throw new Error('code structure index unavailable');
      },
      searchByVector: () => [{ chunkId: 'vector-match', score: 0.95 }],
      searchByText: () => [{ chunkId: 'text-match', score: 4 }],
      searchByLexical: () => [{ chunkId: 'text-match', score: 3 }],
    };
    const retriever = new HybridRetriever(storage as any, new ReliableEmbeddingProvider());

    const results = await retriever.retrieve('authentication login flow', {
      strategy: 'structural',
      topK: 5,
    });

    expect(results.map((result) => result.chunkId)).toEqual(['vector-match', 'text-match']);
    expect(results[0].sourceScores?.structural).toBe(0);
    expect(results[0].reasons).toContain(
      'structural retrieval unavailable: code structure index unavailable'
    );
  });

  it('keeps deterministic structural retrieval usable when structural lookup fails', async () => {
    const chunks = [
      makeChunk('lexical-match', 'src/auth/login.ts', 900),
      makeChunk('unrelated', 'src/cache/store.ts', 900),
    ];
    const storage = {
      ...makeStorage(chunks, {
        'lexical-match': 12,
      }, {}),
      searchByStructure: () => {
        throw new Error('code structure index unavailable');
      },
    };
    const retriever = new HybridRetriever(storage as any, new DeterministicEmbeddingProvider());

    const results = await retriever.retrieve('authentication login flow', {
      strategy: 'structural',
      topK: 5,
    });

    expect(results[0].chunkId).toBe('lexical-match');
    expect(results[0].sourceScores?.fts).toBeGreaterThan(0);
    expect(results[0].reasons).toContain(
      'structural retrieval unavailable: code structure index unavailable'
    );
  });

  it('falls back to vector results when hybrid text sources fail', async () => {
    const chunks = [
      makeChunk('vector-match', 'src/auth/session.ts', 900),
    ];
    const storage = {
      ...makeStorage(chunks, {}, {}),
      searchByVector: () => [{ chunkId: 'vector-match', score: 0.95 }],
      searchByText: () => {
        throw new Error('fts table unavailable');
      },
      searchByLexical: () => {
        throw new Error('lexical scan unavailable');
      },
    };
    const retriever = new HybridRetriever(storage as any, new ReliableEmbeddingProvider());

    const results = await retriever.retrieve('authentication login flow', {
      strategy: 'hybrid',
      topK: 5,
    });

    expect(results[0].chunkId).toBe('vector-match');
    expect(results[0].sources).toEqual(['vector']);
    expect(results[0].sourceScores?.fts).toBe(0);
    expect(results[0].reasons).toContain('full-text retrieval unavailable: fts table unavailable');
    expect(results[0].reasons).toContain('lexical retrieval unavailable: lexical scan unavailable');
  });

  it('throws text retrieval errors when text is the only requested source', async () => {
    const chunks = [
      makeChunk('text-match', 'src/auth/login.ts', 900),
    ];
    const storage = {
      ...makeStorage(chunks, {}, {}),
      searchByText: () => {
        throw new Error('fts table unavailable');
      },
      searchByLexical: () => {
        throw new Error('lexical scan unavailable');
      },
    };
    const retriever = new HybridRetriever(storage as any, new ReliableEmbeddingProvider());

    await expect(retriever.retrieve('authentication login flow', {
      strategy: 'text',
      topK: 5,
    })).rejects.toThrow('fts table unavailable');
  });

  it('keeps hybrid retrieval results when supplemental graph expansion fails', async () => {
    const chunks = [
      makeChunk('seed', 'src/core/retriever.ts', 900),
    ];
    const storage = {
      ...makeStorage(chunks, {}, {}),
      getDependencies: () => {
        throw new Error('dependency table unavailable');
      },
      searchByVector: () => [{ chunkId: 'seed', score: 0.9 }],
      searchByText: () => [{ chunkId: 'seed', score: 4 }],
      searchByLexical: () => [],
    };
    const retriever = new HybridRetriever(storage as any, new ReliableEmbeddingProvider());

    const results = await retriever.retrieve('retrieve budget dependencies', {
      strategy: 'hybrid',
      maxHops: 1,
      topK: 10,
    });

    expect(results.map((result) => result.chunkId)).toEqual(['seed']);
    expect(results[0].sourceScores?.graph).toBe(0);
    expect(results[0].reasons).toContain(
      'graph retrieval unavailable: dependency table unavailable'
    );
  });

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
        types: [
          { name: 'ContextChunk', kind: 'interface' },
          { name: 'ContextFilter', kind: 'interface' },
        ],
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
    expect(filled.selected.map((chunk) => chunk.path)).toContain('src/types/index.ts');
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
