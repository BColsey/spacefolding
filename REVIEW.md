# Spacefolding — Architecture & Implementation Review

## Critical Issues

### C1. Redundancy penalty is O(N²) and unbounded (src/core/scorer.ts:72-80)
The inner loop comparing every chunk pair for redundancy is O(N²) on embeddings AND applies an unbounded penalty (`+= 0.3` per duplicate). With 1000 chunks, that's 1M cosine similarity calls. With 100 chunks that are all similar, the penalty grows to 30.0, but it's clamped by `Math.max(0, 1 - redundancyPenalty)` so it just hits 0. The real problem is **performance** — this will be a bottleneck at scale and the penalty accumulation is meaningless beyond the first few hits.

**Fix:** Cap redundant neighbors checked (e.g., top 10 by similarity), and cap total penalty at 1.0.

### C2. Dependency closure can cascade excessively (src/core/router.ts:73-89)
The while loop runs up to 10 iterations, promoting warm→hot through transitive dependencies. With a deeply connected graph, this can promote far more chunks than intended — potentially pulling most of the warm tier into hot. The iteration cap of 10 is arbitrary and not documented.

**Fix:** Add a maximum number of promoted chunks (e.g., cap hot tier at 60% of total), or make the closure depth configurable.

### C3. `processContext` re-scores ALL chunks every time (src/pipeline/orchestrator.ts:30-60)
Every call to `processContext` fetches ALL chunks from storage, re-analyzes ALL dependencies, re-embeds ALL chunks, and re-scores ALL chunks. There's no caching, no incremental scoring, no delta processing. With 10K chunks, every scoring call means 10K embedding computations. For the deterministic provider this is fast; for the local ONNX model, this will be extremely slow.

**Fix:** Cache embeddings by chunk ID. Only re-embed new/changed chunks. Store embeddings in the DB.

### C4. `removeDependencies` is a no-op (src/pipeline/orchestrator.ts:173-176)
The MCP tool `update_context_graph` with `operation: "remove"` calls this method, which does nothing and silently succeeds. The caller thinks links were removed; they weren't.

**Fix:** Implement `DELETE FROM dependencies WHERE fromId = ? AND toId = ? AND type = ?`.

## Architectural Concerns

### A1. Scorer imports from a concrete provider, not an interface
`src/core/scorer.ts:8` imports `cosineSimilarity` directly from `../providers/deterministic-embedding.js`. This is a **layer violation** — core logic depends on a specific provider implementation. If you swap in a real embedding model, you'd still be importing the deterministic cosine similarity utility from the wrong place.

**Fix:** Move `cosineSimilarity` to `src/core/` or `src/types/` as a pure utility function.

### A2. MCP server accesses private members via bracket notation (src/mcp/server.ts:155-158)
```typescript
pipeline['storage'].getAllChunks()
pipeline['compressionProvider'].compress(...)
```
This breaks encapsulation and couples the MCP layer to the internal structure of `PipelineOrchestrator`. If the private members are renamed, the MCP server silently breaks at runtime.

**Fix:** Add public methods to `PipelineOrchestrator` for the operations the MCP server needs (`getAllChunks()`, `compressChunks()`).

### A3. `PipelineDependencies` type in types/index.ts is unused
Lines 152-190 define a complex `PipelineDependencies` interface that doesn't match the actual constructor signature of `PipelineOrchestrator`. The orchestrator takes individual constructor parameters, not a `PipelineDependencies` object. This type is dead code that will confuse anyone reading the types file.

**Fix:** Either use this type in the orchestrator constructor, or remove it.

### A4. No configuration loading from file
`config.example.json` exists but nothing in the codebase reads it. The `RoutingConfig` is hardcoded as `DEFAULT_ROUTING_CONFIG` in both the CLI and the orchestrator. Environment variables are read for DB_PATH and TRANSPORT, but routing weights, thresholds, and provider configuration are never loaded from a config file.

**Fix:** Add a config loader that reads `config.example.json` (or a user-specified path).

### A5. Provider pattern isn't actually pluggable at runtime
The `createPipeline()` function in `src/cli/index.ts` hardcodes all providers:
```typescript
const embeddingProvider = new DeterministicEmbeddingProvider();
```
Despite the `EMBEDDING_PROVIDER` env var existing in docker-compose.yml, nothing reads it. `LocalEmbeddingProvider` exists but is never wired in.

**Fix:** Read `EMBEDDING_PROVIDER` env var and instantiate the correct provider.

### A6. No graceful shutdown
The SQLite database is never properly closed on process exit. `repository.close()` exists but is never called from the CLI or MCP server. On abrupt termination, the WAL file may not be checkpointed.

**Fix:** Add `process.on('SIGTERM', ...)` and `process.on('SIGINT', ...)` handlers that close the DB.

## Missing Tests

### MT1. No tests for ContextIngester
`src/core/ingester.ts` has 5 methods (`ingestText`, `ingestFile`, `ingestDiff`, `ingestConversation`, `ingestDirectory`) with zero test coverage. The UUID generation, language detection from extension, and classifier delegation are all untested.

### MT2. No tests for DependencyAnalyzer
`src/providers/dependency-analyzer.ts` has 4 detection rules with zero test coverage. The deduplication logic and edge cases (empty chunks, self-references, circular deps) are untested.

### MT3. No tests for SQLiteRepository
The storage layer has zero direct tests. Schema migrations, query filtering, chunk CRUD, dependency storage, and compression cache are all untested. The integration test covers it indirectly but doesn't test edge cases (empty filters, special characters in text, missing chunks).

### MT4. No tests for the MCP server
`src/mcp/server.ts` has zero tests. Tool input validation, error handling for malformed inputs, and response formatting are untested.

### MT5. No tests for the CLI
`src/cli/index.ts` has zero tests. Commander configuration, argument parsing, and command handlers are untested.

### MT6. No tests for providers
`DeterministicEmbeddingProvider`, `DeterministicRerankerProvider`, `DeterministicCompressionProvider`, and `DeterministicTokenEstimator` all have zero unit tests.

### MT7. No edge case tests
Missing test scenarios:
- Empty text ingestion
- Very large text (10MB+) ingestion
- Chunks with special characters (SQL injection attempts)
- Unicode text
- Chunks with identical text (100% redundancy)
- Zero chunks in storage
- Single chunk that is both redundant and a constraint
- Negative timestamps
- Timestamps in the future

## Premise Critique

### P1. The scoring doesn't know the token budget
The most fundamental problem: Spacefolding scores and routes chunks without knowing **how many tokens are available**. It routes to hot/warm/cold based on fixed score thresholds, not based on "do I have room for this in the prompt?" A coding agent typically has a 100K-200K token window. If 80 chunks score above the "hot" threshold, they ALL go to hot — even if that's 500K tokens. The system should accept a token budget and prioritize within it.

### P2. Re-scoring everything on every call is the wrong model
A coding agent doesn't call "score everything" once — it incrementally adds context during a session. The current architecture forces a full re-score on every `processContext` call, which is both wasteful and slow. A better model: score each chunk once when ingested against the current task, cache the score, and only re-score when the task changes.

### P3. The deterministic embeddings are essentially random
Hash-based embeddings produce vectors that have **no semantic relationship** to the text. "Fix the auth bug" and "Fix the authentication bug" get completely different embeddings because they hash differently. The "semantic similarity" score in the scorer is therefore meaningless with the deterministic provider — it's just hash collision noise. This makes the entire scoring system unreliable in the default configuration.

### P4. Hot/Warm/Cold is the right concept but the wrong granularity
The three-tier model is sound, but the routing should be per-query, not global. Currently, routing decisions are stored in `routing_history` but the tiers are recalculated fresh each time. The stored history serves no purpose — it's write-only. Either commit to persistent tier assignments (with a way to promote/demote), or remove the storage overhead.

### P5. Missing the most important use case: context window packing
The real value proposition for a context management tool is: "given 500K tokens of candidate context and a 100K token window, select the optimal 100K." Spacefolding doesn't do this. It scores and categorizes but doesn't pack. It should accept a `maxTokens` parameter and return the best combination of hot+warm+compressed that fits.

## Recommendations

Priority-ranked:

1. **Add token budget awareness** — Accept `maxTokens` in `score_context`, stop routing when hot tier exceeds budget
2. **Cache embeddings in SQLite** — Add an `embeddings` table, avoid recomputing on every call
3. **Wire LocalEmbeddingProvider** — Read `EMBEDDING_PROVIDER` env var, make it actually work
4. **Fix the scoring O(N²)** — Cap redundancy checks, add early termination
5. **Move cosineSimilarity to core** — Remove the provider layer violation
6. **Add public methods to PipelineOrchestrator** — Stop using bracket notation in MCP server
7. **Implement removeDependencies** — Don't silently no-op
8. **Add config file loading** — Make config.example.json actually work
9. **Add graceful shutdown** — Close SQLite on SIGTERM/SIGINT
10. **Add tests for ingester, repository, analyzer** — At minimum, test the core data flow
11. **Remove or use PipelineDependencies type** — Dead code in types/index.ts
