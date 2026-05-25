# indexing-chunking - Progress Tracker

## Status: REVIEW

## Codebase Patterns

- Language inference for ingested files lives in `src/core/ingester.ts`; project ingestion should reuse that helper so extension support stays consistent.
- Stored file paths are normalized to `/` at the ingester/orchestrator boundary so chunks, structural rows, and re-ingest lookups share one path key.
- `PipelineOrchestrator.storeChunkStructure()` is the integration point that keeps code structure aligned with stored chunks. Unsupported files and split metadata parents should clear structural rows.
- Content-hash dedupe can bypass normal storage paths, so deduped and unchanged re-ingest paths must refresh language metadata and structural rows.
- Split chunks carry content hashes when created; the orchestrator may overwrite them with the same SHA-256 hash convention before storage.
- Code chunking should pack top-level declarations into limit-sized children and only split inside a declaration when the declaration itself is oversized.
- `src/providers/symbol-extractor.ts` now delegates to the structural fallback so CLI symbol output and structural indexing do not drift.
- Call references are indexed for imported/external-looking calls, while same-file calls to locally defined symbols are filtered to avoid generic reference noise in structural retrieval.
- `SQLiteRepository.storeChunk()` must preserve dependent rows when updating unchanged text; text changes explicitly clear embeddings and code structure to avoid stale indexes.

## Known Issues

(Issues found during review phase. Highest severity first. Agent resolves these before doing new adversarial reviews.)

## Resolved Issues

(Issues moved here after being fixed and committed.)

## Completed Work Items

- [x] 1. Language Inference And Structural Storage
- [x] 2. Symbol And Reference Coverage
- [x] 3. Re-Ingestion Consistency
- [x] 4. Chunk Boundaries For Retrieval
- [x] 5. Index Profiling And Held-Out Signals

## Iteration Log

- 2026-05-23: Completed work item 1. Exported shared file language inference, added `.mts`/`.cts`/`.mjs`/`.cjs` support, refreshed structural rows on content-hash dedupe and unchanged re-ingest, cleared structure for unsupported files and split parents, and added orchestrator coverage for TypeScript project ingest, unsupported Markdown cleanup, and re-ingest replacement.
  - Verification: `npm run build && npm run lint && npm test`
  - Benchmarks: `npx tsx benchmarks/evaluate.ts --strategy all --json > /tmp/spacefolding-eval.json`; `npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json > /tmp/spacefolding-e2e.json`
  - Benchmark summary: structural recall@10 0.983, nDCG@10 0.890, MRR 0.933; structural e2e average recall 0.950 and average precision 0.394.
- 2026-05-24: Completed work item 2. Expanded structural extraction for exports, inheritance, methods, CommonJS exports, and external/imported call references across the TypeScript fallback and Python helper, merged fallback coverage into tree-sitter results, and kept standalone symbol extraction aligned with the structural fallback. Same-file local call references are filtered so generic symbols do not pollute structural retrieval.
  - Verification: `npm run build && npm run lint && npm test`
  - Benchmarks: `npx tsx benchmarks/evaluate.ts --strategy all --json > /tmp/spacefolding-eval.json`; `npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json > /tmp/spacefolding-e2e.json`
  - Benchmark summary: structural recall@10 0.983, nDCG@10 0.891, MRR 0.933; structural e2e average recall 0.950, average precision 0.405, and focused retrieval gate passing.
- 2026-05-24: Completed work item 3. Replaced chunk update `INSERT OR REPLACE` semantics with upsert behavior that preserves embeddings for reused unchanged split chunks, clears embeddings and code structure when chunk text changes, and explicitly deletes embeddings during chunk deletion. Added coverage proving changed split re-ingestion removes stale child chunks from storage, vector search, dependencies, FTS, and code structure while preserving reused child embeddings; added watcher coverage for modification events using `reingestFile()`.
  - Verification: `npm run build && npm run lint && npm test`
  - Benchmarks: `npx tsx benchmarks/evaluate.ts --strategy all --json > /tmp/spacefolding-eval.json`; `npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json > /tmp/spacefolding-e2e.json`
  - Benchmark summary: structural recall@10 0.983, nDCG@10 0.891, MRR 0.933; structural e2e average recall 0.950 and average precision 0.401.
- 2026-05-24: Completed work item 4. Reworked code chunking to pack top-level declarations into limit-sized chunks, split oversized declarations only as a fallback, keep import context with each code child, add content hash metadata to split parents and children at creation, and apply the same size-aware packing to tree-sitter chunk pieces. Added coverage for TypeScript boundary-aware splitting, child token limits, split metadata hashes, and focused retrieval excluding split metadata parents.
  - Verification: `npm run build && npm run lint && npm test`
  - Benchmarks: `npx tsx benchmarks/evaluate.ts --strategy all --json > /tmp/spacefolding-eval.json`; `npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json > /tmp/spacefolding-e2e.json`
  - Benchmark summary: structural recall@10 0.983, nDCG@10 0.890, MRR 0.933; structural e2e average recall 1.000 and average precision 0.399.
- 2026-05-24: Completed work item 5. Tightened held-out dataset scanning so dependency, build, benchmark, and test/fixture directories are skipped before symbol extraction by default, documented that generated paths follow the evaluator's project-relative path convention, and added coverage proving generated labels are relative and exclude skipped-directory symbols.
  - Verification: `npx vitest run tests/benchmark-heldout.test.ts`; `npm run build && npm run lint && npm test`
  - Held-out sanity check: `npx tsx benchmarks/generate-heldout.ts --corpus benchmarks/fixtures --output /tmp/spacefolding-heldout-fixtures.json --limit 5 --seed indexing-chunking-fixture --include-tests`
  - Held-out summary: 11 source files, 17 symbols, 5 tasks; generated paths were relative and no skipped dependency/build/test paths were present.

## Review Log

(Entries added during review phase: category reviewed, what was checked, what was fixed.)
- 2026-05-25: Review category 1, Spec Compliance. Checked schema migrations, chunk/index lifecycle cleanup, and shared structural/retrieval types against `DESIGN.md` and `IMPLEMENTATION.md`. Fixed retrieval strategy/mode aliases so they are exported from shared types and compatibility re-exported by existing modules, expanded `StorageProvider` to include the indexing/retrieval methods listed in the spec, and added migration version 5 to rebuild FTS for databases that already had chunks before the FTS migration.
  - Verification: `npm run build && npm run lint && npm test`
  - Benchmarks: `npm run build`; `npx tsx benchmarks/evaluate.ts --strategy all --json > /tmp/spacefolding-eval.json`; `npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json > /tmp/spacefolding-e2e.json`
  - Benchmark summary: structural recall@10 0.983, nDCG@10 0.890, MRR 0.933; structural e2e average recall 1.000 and average precision 0.416.
- 2026-05-25: Review category 2, Error Handling. Checked structural extraction fallback behavior, ingest-time best-effort indexing, storage failure propagation, and file read failures. Fixed directory and project ingestion so unreadable files are counted as skipped while chunk storage/database failures are no longer swallowed as skipped files, and added regression coverage for both paths.
  - Verification: `npx vitest run tests/orchestrator.test.ts`; `npm run build && npm run lint && npm test`
- 2026-05-25: Review category 3, Test Coverage. Checked chunking, structural extraction, re-ingestion, watcher modification flow, and vector index deletion coverage from scratch. Added regression coverage for oversized declaration splitting, unsupported-language StructuralIndexer degradation, unchanged file re-ingest without duplicate chunks or structure, and active vector index cleanup when stored chunk text changes.
  - Verification: `npx vitest run tests/chunker.test.ts tests/structural-indexer.test.ts tests/orchestrator.test.ts tests/vector-index.test.ts`; `npm run build && npm run lint && npm test`
- 2026-05-25: Review category 4, Code Consistency. Checked path normalization, language inference, and metadata keys across ingest, re-ingest, structural storage, and project scanning. Fixed direct file ingest/re-ingest to normalize stored paths to `/` before content-hash lookup, chunk creation, structure storage, and delete-by-path, and added regression coverage for backslash paths reusing the same normalized chunk and structural rows.
  - Verification: `npx vitest run tests/orchestrator.test.ts`; `npm run build && npm run lint && npm test`
  - Benchmarks: `npm run build`; `npx tsx benchmarks/evaluate.ts --strategy all --json > /tmp/spacefolding-eval.json`; `npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json > /tmp/spacefolding-e2e.json`
  - Benchmark summary: structural recall@10 0.983, nDCG@10 0.890, MRR 0.933; structural e2e average recall 0.950 and average precision 0.396.
- 2026-05-25: Review category 5, Dead Code. Checked unused extraction helpers, tree-sitter chunker wiring, structural storage methods, and schema columns from scratch. Removed the unused `buildSymbolIndex()` extractor helper and dropped unused internal chunking/tree-sitter parameters while leaving split behavior unchanged.
  - Verification: `npm run build && npm run lint && npm test`
- 2026-05-25: Review category 6, Integration Wiring. Checked ingest, re-ingest, process-context storage, repository FTS triggers, vector persistence, and structural storage wiring from chunk creation through retrieval-visible indexes. Fixed embedding and code-structure repository write failures so they propagate instead of silently dropping index writes, while provider/extractor failures remain best-effort after chunk and FTS storage. Added regression coverage for embedding-provider failure, embedding storage failure, and code-structure storage failure.
  - Verification: `npx vitest run tests/orchestrator.test.ts`; `npm run build && npm run lint && npm test`
- 2026-05-25: Review category 7, Security And Data Integrity. Checked stale chunk deletion, project/corpus path traversal, benchmark output handling, and private-data exposure paths. Fixed project ingest and benchmark corpus walkers so symlinked files/directories are skipped instead of traversed into external source trees, and added regression coverage for project ingest, held-out generation, evaluation corpus walking, and profiling corpus walking.
  - Verification: `npx vitest run tests/benchmark-heldout.test.ts tests/benchmark-evaluate.test.ts tests/orchestrator.test.ts tests/benchmark-profile-security.test.ts`; `npm run build && npm run lint && npm test`
  - Benchmarks: `npm run build`; `npx tsx benchmarks/evaluate.ts --strategy all --json > /tmp/spacefolding-eval.json`; `npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json > /tmp/spacefolding-e2e.json`
  - Benchmark summary: structural recall@10 0.983, nDCG@10 0.890, MRR 0.933; structural e2e average recall 0.950 and average precision 0.406.
- 2026-05-25: Review category 1, Spec Compliance. Re-checked schema/version migrations, chunk/index lifecycle cleanup, shared structural and retrieval types, and public storage interface alignment against `DESIGN.md` and `IMPLEMENTATION.md`. Fixed retrieval mode/strategy drift by exporting shared runtime constants from `src/types/index.ts` and wiring CLI, MCP, web, and benchmark parsing to them; added explicit `StorageProvider` implementation on `SQLiteRepository` so interface drift is caught by TypeScript.
  - Verification: `npm run build && npm run lint && npm test`
