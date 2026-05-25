# indexing-chunking - Autonomous Agent Instructions

## Housekeeping

Ignore:

- `ralph-indexing-chunking.log`
- `coverage/`
- `benchmarks/*.db`
- `benchmarks/*.db-wal`
- `benchmarks/*.db-shm`
- `/tmp/spacefolding-*.json`

Pre-existing uncommitted changes are not your problem. Only commit files you changed.

## Prime Directive

You are improving the indexes and chunks that retrieval depends on. This loop should make structural search more complete, keep embeddings and code structure consistent, and prevent stale chunks from polluting retrieval.

This loop depends on measurement being good enough to reveal indexing failures. It should not tune fusion weights unless an indexing bug exposes a retrieval test failure.

## Authority Hierarchy

1. `DESIGN.md`
2. `IMPLEMENTATION.md`
3. This prompt

## Rules of Engagement

Non-negotiable:

1. Read `progress-indexing-chunking.md` first.
2. One work item per iteration.
3. Any chunk lifecycle change must prove storage, embeddings, FTS, and code structure stay consistent.
4. Structural extraction must degrade safely when a language is unsupported.
5. Re-ingestion must not duplicate stale chunks for the same path.

Prohibited:

- No private benchmark datasets committed.
- No schema change without migration and `CURRENT_VERSION` update.
- No leaving code structure for deleted chunks.
- No requiring network access for tests.
- No writing "Loop Complete" or "Loop Done" in the progress file.

## Environment

- Working directory: `/home/ben/Documents/Projects/spacefolding`
- Language: TypeScript ESM on Node
- Test framework: Vitest
- Progress file: `progress-indexing-chunking.md`

## Quality Gate

Run after every code change:

```bash
npm run build && npm run lint && npm test
```

Run benchmark commands when indexing changes may affect retrieval quality:

```bash
npm run build
npx tsx benchmarks/evaluate.ts --strategy all --json > /tmp/spacefolding-eval.json
npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json > /tmp/spacefolding-e2e.json
```

## Workflow Per Iteration

1. Read `progress-indexing-chunking.md`.
2. Fix Known Issues first.
3. Otherwise choose the lowest-numbered incomplete work item.
4. Read referenced specs.
5. Implement and test.
6. Run quality gate.
7. Commit only your changes.
8. Update progress.

## Work Items

### 1. Language Inference And Structural Storage

Spec sections: `DESIGN.md` "Indexing Design", `IMPLEMENTATION.md` sections 4 and 6.
Files: `src/pipeline/orchestrator.ts`, `src/core/ingester.ts`, `src/providers/structural-indexer.ts`, `tests/orchestrator.test.ts`, `tests/symbol-extractor.test.ts`.

Deliver:

- Ensure ingested project files get a supported language when extension is known.
- Ensure `storeChunkStructure()` stores symbols/references for supported code files.
- Ensure unsupported files delete stale structure for that chunk.

Tests:

- TypeScript file ingest stores at least one symbol when content contains an exported function/class/interface.
- Markdown or unsupported file stores no code structure.
- Re-ingesting a supported file refreshes structure rather than appending duplicates.

Done when: structural search has reliable data for supported code files.

### 2. Symbol And Reference Coverage

Spec sections: `DESIGN.md` "Indexing Design", `IMPLEMENTATION.md` sections 5 and 6.
Files: `src/providers/structural-indexer.ts`, `src/providers/symbol-extractor.ts`, `scripts/structural-indexer.py`, `tests/symbol-extractor.test.ts`, `tests/structural-indexer.test.ts`.

Deliver:

- Improve extraction for functions, classes, interfaces, types, methods, imports, exports, and calls in existing supported languages.
- Preserve normalized names using existing normalization helpers.
- Keep regex fallback deterministic when tree-sitter or Python helpers are unavailable.

Tests:

- Exported TypeScript function has `isExported: true`.
- Class method has kind `method`.
- Import/reference rows normalize target names.
- Empty or malformed source returns no symbols without throwing.

Done when: common code constructs are searchable through `searchByStructure()`.

### 3. Re-Ingestion Consistency

Spec sections: `DESIGN.md` "Indexing Design", `IMPLEMENTATION.md` section 6.
Files: `src/pipeline/orchestrator.ts`, `src/storage/repository.ts`, `src/core/watcher.ts`, `tests/orchestrator.test.ts`, `tests/vector-index.test.ts`.

Deliver:

- Changed file re-ingestion reuses unchanged split chunks by content hash.
- Deleted stale chunks remove dependencies, embeddings, and code structure.
- Parent/child `contains` dependencies reflect the current file only.

Tests:

- Re-ingesting unchanged content returns `changed: false`.
- Re-ingesting changed split content deletes stale child chunks.
- Deleted child chunk is absent from `chunks`, vector search, dependencies, and code structure.
- Watcher modification path calls the re-ingest flow rather than adding duplicate path chunks.

Done when: file changes do not leave stale index data behind.

### 4. Chunk Boundaries For Retrieval

Spec sections: `DESIGN.md` "Selection And Budgeting", `IMPLEMENTATION.md` sections 6 and 7.
Files: `src/core/chunker.ts`, `src/core/tree-sitter-chunker.ts`, `src/core/ingester.ts`, `tests/chunker.test.ts`.

Deliver:

- Preserve useful function/class/section boundaries when splitting large files.
- Parent split chunks remain metadata containers and are not returned by focused retrieval.
- Child chunks carry enough path, language, parent, and content hash metadata for retrieval and re-ingestion.

Tests:

- Large TypeScript file splits at code-aware boundaries when possible.
- Parent has `metadata.split` and children have `parentId`.
- Children total token estimates stay within configured split limits.
- Focused retrieval excludes parent metadata chunk.

Done when: retrieval works on meaningful chunk units.

### 5. Index Profiling And Held-Out Signals

Spec sections: `DESIGN.md` "Benchmark Design", `IMPLEMENTATION.md` section 10.
Files: `benchmarks/profile-retrieval.ts`, `benchmarks/generate-heldout.ts`, `benchmarks/HELDOUT.md`, tests if needed.

Deliver:

- Ensure profiling reports chunk count, symbol count, reference count, SQLite footprint, ingest time, latency percentiles, returned tokens, and memory usage.
- Ensure held-out generator skips dependency/build/test directories by default.
- Ensure generated paths match paths stored by evaluation ingest.

Tests:

- Run `npm run build && npm run lint && npm test`.
- Generate a tiny held-out dataset under `/tmp` if a local public corpus exists.
- Verify generated paths are relative and no private files are committed.

Done when: index quality can be evaluated beyond this repository.

## Review Phase

When all work items are done, enter review. You NEVER write "Loop Complete" or "Loop Done" in `progress-indexing-chunking.md`.

Review mode is cyclic and indefinite. The fact that every category already has
an entry is not a stopping condition and is not a reason for a no-op iteration.
The human stops the loop.

At the start of every review iteration:

1. Read Known Issues. If any are present, fix all Known Issues first, highest
   severity first, then run the quality gate and commit the fixes.
2. If Known Issues is empty, choose exactly one review category for a full
   sweep. Use the categories in order below. If all categories already have
   entries in Review Log, cycle back to category 1 and continue with a fresh
   sweep.
3. Re-evaluate the chosen category from scratch. Do not say "already reviewed",
   "no work left", or "same as prior cycle".
4. If you find defects, fix them in the same iteration.
5. If a complete fresh sweep finds no defects, still run
   `npm run build && npm run lint && npm test`, add a Review Log entry naming
   the exact category and what was checked, and commit the progress-file update.

Review categories:

1. Spec Compliance: schema, lifecycle, and structural types.
2. Error Handling: extraction fallback, DB errors, file read failures.
3. Test Coverage: chunking, structural extraction, re-ingestion, vector index deletion.
4. Code Consistency: path normalization, language inference, metadata keys.
5. Dead Code: unused extraction helpers, unwired indexers, unused schema columns.
6. Integration Wiring: ingestion path actually stores embeddings, FTS, and code structure.
7. Security And Data Integrity: stale chunk deletion, path traversal in benchmark helpers, private data handling.

Known Issues always come first. If you find a defect, fix it.

## Reminders

- Retrieval can only rank what indexing makes visible.
- Every chunk delete must clean dependent indexes.
- Unsupported languages should degrade, not throw.
- Do not commit generated held-out data.
- Never write "Loop Complete" in the progress file.
