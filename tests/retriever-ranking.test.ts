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
  const getCodeSymbols = (chunkId: string): CodeSymbol[] => {
    const chunk = chunkMap.get(chunkId);
    if (!chunk) return [];
    return (symbols[chunkId] ?? []).map((symbol) => {
      if (typeof symbol === 'string') return makeSymbol(chunk, symbol);
      return makeSymbol(chunk, symbol.name, symbol.kind);
    });
  };
  const getCodeReferences = (chunkId: string): CodeReference[] => {
    const chunk = chunkMap.get(chunkId);
    if (!chunk) return [];
    return (references[chunkId] ?? []).map((target) => makeReference(chunk, target));
  };

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
    getCodeSymbols,
    getCodeReferences,
    getAllCodeSymbols: () => chunks.flatMap((chunk) => getCodeSymbols(chunk.id)),
    getAllCodeReferences: () => chunks.flatMap((chunk) => getCodeReferences(chunk.id)),
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

    // Per-source scores are now RRF contributions (weight / (60 + rank)), so
    // each is small (O(0.0x)), not the old min-max-normalized 0..weight scale.
    const scores = results[0].sourceScores!;
    expect(scores.vector).toBeLessThan(0.05);
    expect(scores.fts).toBeLessThan(0.05);
    // final is the sum of the per-source RRF contributions plus the rescaled
    // exact-identifier boost; it stays on the same small RRF magnitude.
    expect(scores.final).toBeLessThan(0.5);
    expect(scores.final).toBeGreaterThan(0);
  });

  it('returns no results when every source is below its relevance floor', async () => {
    const chunks = [
      makeChunk('weak-vector', 'src/unrelated/thing.ts', 900),
    ];
    const storage = {
      ...makeStorage(chunks, {}, {}),
      // Below the cosine relevance floor (0.2) — pure noise, should be dropped.
      searchByVector: () => [{ chunkId: 'weak-vector', score: 0.05 }],
      // No structural, FTS, or lexical matches for this query.
      searchByStructure: () => [],
      searchByText: () => [],
      searchByLexical: () => [],
    };
    const retriever = new HybridRetriever(storage as any, new ReliableEmbeddingProvider());

    const results = await retriever.retrieve('completely unrelated query', {
      strategy: 'vector',
      topK: 5,
    });

    expect(results).toEqual([]);
  });

  it('drops structural results with non-positive score before RRF ranking', async () => {
    const chunks = [
      makeChunk('zero-structural', 'src/core/zero.ts', 900),
    ];
    const storage = {
      ...makeStorage(chunks, {}, {}),
      // structuralScore 0 must not contribute under the absolute relevance floor.
      searchByStructure: () => [
        makeStructuralResult('zero-structural', 0, 0, ['weak heuristic']),
      ],
      searchByVector: () => [{ chunkId: 'zero-structural', score: 0.05 }],
      searchByText: () => [],
      searchByLexical: () => [],
    };
    const retriever = new HybridRetriever(storage as any, new ReliableEmbeddingProvider());

    const results = await retriever.retrieve('no real match here', {
      strategy: 'structural',
      topK: 5,
    });

    expect(results).toEqual([]);
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
    // 'c' had cosine score 0, below the 0.2 relevance floor, so it is dropped
    // before RRF ranking and never appears in the fused results.
    expect(results.map((result) => result.chunkId)).not.toContain('c');
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

  it('batches structural field lookups during deterministic structural scans', async () => {
    const chunks = [
      makeChunk('owner', 'src/domain/target.ts', 900),
      makeChunk('reference', 'src/domain/caller.ts', 900),
      makeChunk('noise', 'src/domain/noise.ts', 900),
    ];
    const baseStorage = makeStorage(
      chunks,
      {},
      {
        owner: ['TargetSymbol'],
      },
      {
        reference: ['TargetSymbol'],
      }
    );
    const storage = {
      ...baseStorage,
      getCodeSymbols: vi.fn(baseStorage.getCodeSymbols),
      getCodeReferences: vi.fn(baseStorage.getCodeReferences),
      getAllCodeSymbols: vi.fn(baseStorage.getAllCodeSymbols),
      getAllCodeReferences: vi.fn(baseStorage.getAllCodeReferences),
    };
    const retriever = new HybridRetriever(storage as any, new DeterministicEmbeddingProvider());

    const results = await retriever.retrieve('where is TargetSymbol defined', {
      strategy: 'structural',
      topK: 5,
    });

    expect(storage.getAllCodeSymbols).toHaveBeenCalledTimes(1);
    expect(storage.getAllCodeReferences).toHaveBeenCalledTimes(1);
    expect(storage.getCodeSymbols).not.toHaveBeenCalled();
    expect(storage.getCodeReferences).not.toHaveBeenCalled();
    expect(results.map((result) => result.chunkId)).toEqual(['owner', 'reference']);
    expect(results[0].reasons).toContain('sparse exact identifier symbol: TargetSymbol');
    expect(results[1].reasons).toContain('sparse exact identifier reference: TargetSymbol');
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

  // NOTE: Four tests were removed here. They asserted that generic English
  // queries ("batch delete...", "embedding providers", "reranking step /
  // cross-encoder", "auth 401 login flow") promoted this repository's own
  // modules (repository.ts, EmbeddingProvider, RerankerProvider, scorer/router).
  // That behavior only existed because of hardcoded TERM_EXPANSIONS /
  // PHRASE_EXPANSIONS tables that mapped generic words to this repo's symbols —
  // i.e. train-on-test contamination. The tables were deleted; corpus-derived
  // expansion validated against a FOREIGN fixture corpus is the follow-up
  // (see IMPLEMENTATION-PLAN.md, WS0.2). Budget behavior these tests also touched
  // is covered by tests/budget.test.ts.
  it('treats single capitalized explain terms as exact symbol targets', async () => {
    const chunks = [
      makeChunk('platforms', 'src/delia/platforms.py', 800),
      makeChunk('dependencies', 'src/delia/delialsp/dependencies.py', 1_200),
    ];
    const storage = makeStorage(
      chunks,
      {
        platforms: 16,
        dependencies: 2,
      },
      {
        dependencies: [{ name: 'Platform', kind: 'enum' }],
      }
    );
    const retriever = new HybridRetriever(storage as any, new DeterministicEmbeddingProvider());

    const results = await retriever.retrieve('what does Platform do', {
      strategy: 'structural',
      topK: 10,
    });
    const rankedIds = results.map((result) => result.chunkId);

    expect(rankedIds.indexOf('dependencies')).toBeLessThan(rankedIds.indexOf('platforms'));
    expect(results.find((result) => result.chunkId === 'dependencies')?.reasons).toContain(
      'sparse exact identifier case match: Platform'
    );
  });

  it('prefers lowercase function symbols over uppercase HTTP handlers for lowercase debug subjects', async () => {
    const chunks = [
      makeChunk('client-api', 'factory-ui/client/src/lib/api.ts', 700),
      makeChunk('incident-route', 'factory-ui/server/src/routes/incidents.ts', 900),
      makeChunk('db', 'supervisor/src/db.ts', 1_000),
    ];
    const storage = makeStorage(
      chunks,
      {
        'incident-route': 18,
        db: 14,
        'client-api': 2,
      },
      {
        'client-api': ['patch'],
        'incident-route': ['PATCH'],
      }
    );
    const retriever = new HybridRetriever(storage as any, new DeterministicEmbeddingProvider());

    const results = await retriever.retrieve('patch is returning wrong values', {
      strategy: 'structural',
      topK: 10,
    });
    const rankedIds = results.map((result) => result.chunkId);

    expect(rankedIds.indexOf('client-api')).toBeLessThan(rankedIds.indexOf('incident-route'));
    expect(results.find((result) => result.chunkId === 'client-api')?.reasons).toContain(
      'sparse exact identifier case match: patch'
    );
  });
});
