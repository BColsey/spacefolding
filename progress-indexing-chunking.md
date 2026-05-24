# indexing-chunking - Progress Tracker

## Status: IN PROGRESS

## Codebase Patterns

- Language inference for ingested files lives in `src/core/ingester.ts`; project ingestion should reuse that helper so extension support stays consistent.
- `PipelineOrchestrator.storeChunkStructure()` is the integration point that keeps code structure aligned with stored chunks. Unsupported files and split metadata parents should clear structural rows.
- Content-hash dedupe can bypass normal storage paths, so deduped and unchanged re-ingest paths must refresh language metadata and structural rows.

## Known Issues

(Issues found during review phase. Highest severity first. Agent resolves these before doing new adversarial reviews.)

## Resolved Issues

(Issues moved here after being fixed and committed.)

## Completed Work Items

- [x] 1. Language Inference And Structural Storage

## Iteration Log

- 2026-05-23: Completed work item 1. Exported shared file language inference, added `.mts`/`.cts`/`.mjs`/`.cjs` support, refreshed structural rows on content-hash dedupe and unchanged re-ingest, cleared structure for unsupported files and split parents, and added orchestrator coverage for TypeScript project ingest, unsupported Markdown cleanup, and re-ingest replacement.
  - Verification: `npm run build && npm run lint && npm test`
  - Benchmarks: `npx tsx benchmarks/evaluate.ts --strategy all --json > /tmp/spacefolding-eval.json`; `npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json > /tmp/spacefolding-e2e.json`
  - Benchmark summary: structural recall@10 0.983, nDCG@10 0.890, MRR 0.933; structural e2e average recall 0.950 and average precision 0.394.

## Review Log

(Entries added during review phase: category reviewed, what was checked, what was fixed.)
