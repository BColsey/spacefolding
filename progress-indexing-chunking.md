# indexing-chunking - Progress Tracker

## Status: IN PROGRESS

## Codebase Patterns

- Language inference for ingested files lives in `src/core/ingester.ts`; project ingestion should reuse that helper so extension support stays consistent.
- `PipelineOrchestrator.storeChunkStructure()` is the integration point that keeps code structure aligned with stored chunks. Unsupported files and split metadata parents should clear structural rows.
- Content-hash dedupe can bypass normal storage paths, so deduped and unchanged re-ingest paths must refresh language metadata and structural rows.
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

## Review Log

(Entries added during review phase: category reviewed, what was checked, what was fixed.)
