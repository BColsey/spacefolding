# E2E Benchmark Results - Focused Structural Retrieval

Last verified: 2026-05-24

Command:

```sh
npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json > /tmp/spacefolding-e2e.json
```

Generated benchmark JSON is a temporary artifact. Keep it under `/tmp` and do
not commit it.

## Summary

| Metric | Value | Acceptance |
|--------|:-----:|:----------:|
| Average recall | 1.000 | >= 0.950 |
| Average precision | 0.408 | >= 0.350 |
| Average tokens | 10,887.5 | <= 13,000 |
| Full codebase tokens | 41,098 | No task may exceed this |
| Average tokens vs current hybrid | 1,773.4 fewer | > 0 fewer |
| Average recall vs current hybrid | +0.383 | > 0 |
| Average precision vs current hybrid | +0.215 | > 0 |
| Tasks returning more than the codebase | 0 | 0 |

`successGate.focusedRetrievalPasses` is `true`, and
`summary.tasksReturningMoreThanCodebase` is empty for this run.

## Task Details

| Task | Name | Recall | Precision | Tokens | Chunks | More than codebase | Missed files |
|------|------|:------:|:---------:|-------:|:------:|:------------------:|--------------|
| E01 | Add OpenAI embedding provider | 1.000 | 0.600 | 7,392 | 6 | no | - |
| E02 | Wire reranker into pipeline | 1.000 | 0.600 | 7,168 | 7 | no | - |
| E03 | Add TTL-based chunk eviction | 1.000 | 0.200 | 12,357 | 13 | no | - |
| E04 | Per-file statistics in web UI | 1.000 | 0.222 | 12,608 | 13 | no | - |
| E05 | Incremental file re-ingestion | 1.000 | 0.286 | 12,854 | 9 | no | - |
| E06 | Add batch delete MCP tool | 1.000 | 0.600 | 11,847 | 7 | no | - |
| E07 | Fix budget controller overflow | 1.000 | 0.286 | 12,775 | 11 | no | - |
| E08 | Add query expansion to planner | 1.000 | 0.667 | 6,376 | 5 | no | - |
| E09 | Add compression quality metric | 1.000 | 0.333 | 12,592 | 10 | no | - |
| E10 | Add context type to web display | 1.000 | 0.286 | 12,906 | 9 | no | - |

## Notes

- `benchmarks/e2e-benchmark.ts` measures developer-task usefulness: expected
  file recall, returned-context precision, token volume, and current-vs-selected
  deltas.
- Positive `averageTokensVsCurrent` means the selected structural strategy used
  fewer tokens than the current hybrid comparison.
- The E2E JSON is the source of truth for acceptance checking; this page is a
  compact snapshot of the last verified local run.
