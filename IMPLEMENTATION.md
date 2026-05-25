# Spacefolding Implementation Contract

## 1. Authority Hierarchy

1. `DESIGN.md` defines product behavior and success criteria.
2. `IMPLEMENTATION.md` defines exact contracts, file ownership, and quality gates.
3. `PROMPT-*.md` files define loop-specific work items.

If implementation details conflict, `IMPLEMENTATION.md` wins. If product rationale conflicts, `DESIGN.md` wins.

## 2. Module Layout

Core runtime files:

- `src/types/index.ts`: shared types and provider interfaces.
- `src/main.ts`: executable entrypoint.
- `src/cli/index.ts`: CLI commands and provider wiring.
- `src/mcp/server.ts`: MCP tools.
- `src/web/server.ts`: web server and browser UI.
- `src/pipeline/orchestrator.ts`: high-level ingest, retrieval, scoring, compression, deletion, and project operations.
- `src/core/retriever.ts`: hybrid retrieval, fusion, reranking, graph expansion.
- `src/core/query-planner.ts`: intent, complexity, strategy, topK, budget planning.
- `src/core/retrieval-policy.ts`: focused/broad/exhaustive candidate selection.
- `src/core/budget.ts`: token budget filling and optional compression of omitted chunks.
- `src/core/ingester.ts`: chunk creation.
- `src/core/chunker.ts` and `src/core/tree-sitter-chunker.ts`: content splitting.
- `src/core/scorer.ts` and `src/core/router.ts`: score and route context tiers.
- `src/core/watcher.ts`: file watching and re-ingestion.
- `src/storage/schema.ts`: SQLite schema and migrations.
- `src/storage/repository.ts`: SQLite repository.
- `src/storage/vector-index.ts`: vector index abstraction and implementations.
- `src/providers/*.ts`: embedding, compression, reranking, token, dependency, and structural providers.

Benchmark and docs files:

- `benchmarks/evaluate.ts`: retrieval benchmark.
- `benchmarks/e2e-benchmark.ts`: E2E token-efficiency benchmark.
- `benchmarks/check-acceptance.ts`: pass/fail acceptance checker.
- `benchmarks/generate-heldout.ts`: held-out dataset generator.
- `benchmarks/profile-retrieval.ts`: ingest and latency profiler.
- `benchmarks/ACCEPTANCE.md`: acceptance gate instructions.
- `benchmarks/HELDOUT.md`: held-out benchmark instructions.
- `README.md`, `docs/configuration.md`, `docs/integration-guide.md`: user docs.

Ralph files:

- `PROMPT-measurement.md`, `progress-measurement.md`
- `PROMPT-retrieval-ranking.md`, `progress-retrieval-ranking.md`
- `PROMPT-indexing-chunking.md`, `progress-indexing-chunking.md`
- `PROMPT-integration-polish.md`, `progress-integration-polish.md`
- `ralph.sh`

## 3. Dependencies

The Node package is defined in `package.json`.

Runtime dependencies:

- `@huggingface/transformers`
- `@modelcontextprotocol/sdk`
- `better-sqlite3`
- `chalk`
- `chokidar`
- `commander`
- `sqlite-vec`

Dev dependencies:

- `@types/better-sqlite3`
- `@types/node`
- `tsx`
- `typescript`
- `vitest`

Do not add dependencies unless a work item requires it and tests prove the dependency is used in the running system.

## 4. Database Schema

`src/storage/schema.ts` is the source of truth. The schema must include these tables and indexes:

```sql
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  path TEXT,
  language TEXT,
  tokensEstimate INTEGER NOT NULL DEFAULT 0,
  parentId TEXT,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS dependencies (
  fromId TEXT NOT NULL,
  toId TEXT NOT NULL,
  type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.5,
  PRIMARY KEY (fromId, toId, type)
);

CREATE TABLE IF NOT EXISTS routing_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunkId TEXT NOT NULL,
  tier TEXT NOT NULL,
  score REAL NOT NULL,
  reasons TEXT NOT NULL DEFAULT '[]',
  taskText TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS compression_cache (
  id TEXT PRIMARY KEY,
  taskText TEXT NOT NULL,
  summary TEXT NOT NULL,
  retainedFacts TEXT NOT NULL DEFAULT '[]',
  retainedConstraints TEXT NOT NULL DEFAULT '[]',
  sourceChunkIds TEXT NOT NULL DEFAULT '[]',
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunkId TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (chunkId) REFERENCES chunks(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  path UNINDEXED,
  source UNINDEXED,
  type UNINDEXED,
  content='chunks',
  content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS code_symbols (
  id TEXT PRIMARY KEY,
  chunkId TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  normalizedName TEXT NOT NULL,
  kind TEXT NOT NULL,
  signature TEXT,
  startLine INTEGER NOT NULL,
  endLine INTEGER NOT NULL,
  isExported INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (chunkId) REFERENCES chunks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS code_references (
  id TEXT PRIMARY KEY,
  chunkId TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL,
  normalizedTarget TEXT NOT NULL,
  kind TEXT NOT NULL,
  startLine INTEGER NOT NULL,
  endLine INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (chunkId) REFERENCES chunks(id) ON DELETE CASCADE
);
```

Migration order is owned by `MIGRATIONS` in `src/storage/schema.ts`. New schema changes must increment `CURRENT_VERSION` in `src/storage/current-version.ts`.

## 5. Shared Types

Use the exact exported types in `src/types/index.ts`.

Important aliases:

- `ChunkType = 'fact' | 'constraint' | 'instruction' | 'code' | 'log' | 'background' | 'summary' | 'diff' | 'reference'`
- `ContextTier = 'hot' | 'warm' | 'cold' | 'compressed'`
- `DependencyType = 'references' | 'defines' | 'summarizes' | 'overrides' | 'contains'`
- `CodeSymbolKind = 'function' | 'class' | 'interface' | 'type' | 'variable' | 'method' | 'struct' | 'enum' | 'trait' | 'module' | 'field' | 'constant'`
- `CodeReferenceKind = 'import' | 'export' | 'call' | 'type' | 'module' | 'inheritance' | 'use'`
- `RetrievalStrategy = 'hybrid' | 'vector' | 'text' | 'graph' | 'structural'`
- `RetrievalMode = 'focused' | 'broad' | 'exhaustive'`

Do not introduce duplicate definitions of these concepts in loop prompts or new code.

## 6. Public Interfaces

Provider interfaces from `src/types/index.ts`:

```typescript
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export interface RerankerProvider {
  rerank(query: string, documents: string[]): Promise<{ index: number; score: number; reason: string }[]>;
}

export interface CompressionProvider {
  compress(task: TaskDescription, chunks: ContextChunk[]): Promise<CompressionResult>;
}

export interface TokenEstimator {
  estimate(text: string): number;
}

export interface DependencyAnalyzer {
  analyze(chunks: ContextChunk[]): DependencyLink[];
}
```

Repository methods used by retrieval and indexing:

```typescript
storeChunk(chunk: ContextChunk): void;
getChunk(id: string): ContextChunk | null;
queryChunks(filter: ContextFilter): ContextChunk[];
getAllChunks(): ContextChunk[];
updateChunk(chunk: ContextChunk): void;
deleteChunk(id: string): void;
storeDependency(link: DependencyLink): void;
removeDependency(fromId: string, toId: string, type: DependencyType): void;
removeAllDependenciesForChunk(chunkId: string): void;
getDependencies(chunkId: string): DependencyLink[];
storeEmbedding(chunkId: string, embedding: number[], model: string): void;
searchByVector(queryEmbedding: number[], topK?: number): { chunkId: string; score: number }[];
searchByText(query: string, topK?: number): { chunkId: string; score: number }[];
searchByLexical(query: string, topK?: number): { chunkId: string; score: number }[];
storeCodeStructure(chunkId: string, symbols: CodeSymbol[], references: CodeReference[]): void;
deleteCodeStructure(chunkId: string): void;
getCodeSymbols(chunkId: string): CodeSymbol[];
getCodeReferences(chunkId: string): CodeReference[];
getAllCodeSymbols(): CodeSymbol[];
hasCodeStructure(): boolean;
searchByStructure(query: StructuralQuery, topK?: number): StructuralSearchResult[];
```

Pipeline retrieval contract:

```typescript
async retrieve(
  query: string,
  maxTokens?: number,
  options?: RetrievalOptions
): Promise<{
  chunks: ContextChunk[];
  tiers: Map<string, ContextTier>;
  totalTokens: number;
  budget: number;
  hardBudget: number;
  targetBudget: number;
  utilization: number;
  omitted: { chunkId: string; tokensEstimate: number; reason: string }[];
  compressed: { chunkId: string; summary: string; tokensEstimate: number }[];
  plan: QueryPlan;
  retrieval: RetrievalResult[];
  selectionPolicy: RetrievalSelectionPolicy & {
    effectiveBudget: number;
    selectedCandidates: number;
    droppedCandidates: number;
  };
}>;
```

## 7. Retrieval Behavior

`planQuery(query)` must return:

- `intent`
- `expandedTerms`
- `strategy`
- `maxHops`
- `tokenBudgetRatio`
- `complexity`
- `structuralQuery`
- `recommendedTopK`

`HybridRetriever.retrieve(query, options)` must:

- Use structural search for `strategy === 'structural'`.
- Use vector search for `strategy === 'hybrid' | 'vector' | 'structural'`.
- Use FTS/lexical search for `strategy === 'hybrid' | 'text' | 'structural'`.
- Use graph traversal only for `strategy === 'graph'` or explicit hybrid graph options.
- Return `RetrievalResult[]` with `chunkId`, `score`, `sources`, `sourceScores`, and `reasons`.
- Prefer score-weighted fusion over rank-only fusion.
- Keep deterministic embedding behavior from becoming random vector noise.

`createRetrievalSelectionPolicy()` must produce focused, broad, and exhaustive behavior:

- Focused target budgets: narrow `6000`, moderate `13000`, broad `18000`.
- Broad target budgets: narrow `16000`, moderate `28000`, broad `40000`.
- Exhaustive target budget equals hard budget.
- Focused mode must apply a score threshold and per-path cap.

`fillBudget()` must never exceed `maxTokens`.

## 8. Configuration

Environment variables used by runtime:

- `DB_PATH`: SQLite database path.
- `MODEL_PATH`: embedding model cache path.
- `EMBEDDING_PROVIDER`: `deterministic`, `local`, or `gpu`.
- `COMPRESSION_PROVIDER`: deterministic/local/LLM provider depending on current code.
- `MAX_CHUNKS`: maximum stored chunks before eviction.
- Provider-specific variables documented in `docs/configuration.md`.

Environment variables used by ralph:

- `RALPH_AGENT_CMD`: custom agent command that reads prompt from stdin.
- `RALPH_SLEEP_SECONDS`: delay between successful ralph iterations.

## 9. Error Handling

Production code may ignore errors only when one of these is true:

- Cleanup/unwind is already returning a more important error.
- The ignored return follows a documented Node or library idiom.
- `DESIGN.md` or this file explicitly marks the operation best-effort.

Embedding and structure extraction failures are best-effort during ingest: the chunk must still be stored, and retrieval must degrade to available indexes.

Benchmark and acceptance scripts must fail loudly on malformed JSON, missing strategy summaries, or missing E2E summaries.

## 10. Testing Strategy

Required local gate:

```bash
npm run build && npm run lint && npm test
```

Acceptance gate:

```bash
npm run build
npx tsx benchmarks/evaluate.ts --strategy all --json > /tmp/spacefolding-eval.json
npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json > /tmp/spacefolding-e2e.json
npx tsx benchmarks/check-acceptance.ts \
  --retrieval-json /tmp/spacefolding-eval.json \
  --e2e-json /tmp/spacefolding-e2e.json
```

Held-out sanity check:

```bash
npx tsx benchmarks/generate-heldout.ts \
  --corpus /path/to/other/repo \
  --output /tmp/spacefolding-heldout-repo.json \
  --limit 60
npm run build
npx tsx benchmarks/evaluate.ts \
  --dataset /tmp/spacefolding-heldout-repo.json \
  --corpus /path/to/other/repo \
  --strategy all \
  --json > /tmp/spacefolding-heldout-eval.json
```

Do not commit generated JSON from `/tmp`.

## 11. Loop Ownership

`measurement` owns benchmark scripts, acceptance docs, and benchmark diagnostics.

`retrieval-ranking` owns query planning, retrieval fusion, reranking, selection policy, and budget behavior.

`indexing-chunking` owns chunking, language inference, symbol/reference extraction, embedding/index lifecycle, and re-ingestion consistency.

`integration-polish` owns MCP, CLI, web, docs, and final acceptance wiring.

Loops may add tests anywhere needed. Loops may fix bugs outside their ownership only when the quality gate or current work item requires it, and must document the reason in the progress file.

## 12. v1 Constraints And Deferrals

In scope:

- Local deterministic retrieval improvements.
- Focused token efficiency.
- Benchmark credibility.
- Runtime wiring to existing surfaces.

Out of scope:

- Replacing SQLite.
- Cloud-only dependencies.
- Human evaluation studies.
- Private held-out datasets committed to the repo.
- A full rewrite of the CLI, MCP server, or web UI.

