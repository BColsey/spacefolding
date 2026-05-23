# E2E Benchmark Results - Focused Structural Retrieval

Last verified: 2026-05-23

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
| Average precision | 0.388 | >= 0.350 |
| Average tokens | 12,444.3 | <= 13,000 |
| Full codebase tokens | 37,945 | No task may exceed this |
| Average tokens vs current hybrid | 478.5 fewer | > 0 fewer |
| Average recall vs current hybrid | +0.400 | > 0 |
| Average precision vs current hybrid | +0.203 | > 0 |
| Tasks returning more than the codebase | 0 | 0 |

`successGate.focusedRetrievalPasses` is `true`, and
`summary.tasksReturningMoreThanCodebase` is empty for this run.

## Task Details

| Task | Name | Recall | Precision | Tokens | Chunks | More than codebase | Missed files |
|------|------|:------:|:---------:|-------:|:------:|:------------------:|--------------|
| E01 | Add OpenAI embedding provider | 1.000 | 0.333 | 12,838 | 11 | no | - |
| E02 | Wire reranker into pipeline | 1.000 | 0.429 | 12,811 | 9 | no | - |
| E03 | Add TTL-based chunk eviction | 1.000 | 0.250 | 12,744 | 10 | no | - |
| E04 | Per-file statistics in web UI | 1.000 | 0.333 | 12,861 | 7 | no | - |
| E05 | Incremental file re-ingestion | 1.000 | 0.286 | 12,758 | 10 | no | - |
| E06 | Add batch delete MCP tool | 1.000 | 0.375 | 12,490 | 10 | no | - |
| E07 | Fix budget controller overflow | 1.000 | 0.286 | 12,800 | 9 | no | - |
| E08 | Add query expansion to planner | 1.000 | 1.000 | 9,959 | 4 | no | - |
| E09 | Add compression quality metric | 1.000 | 0.300 | 12,366 | 11 | no | - |
| E10 | Add context type to web display | 1.000 | 0.286 | 12,816 | 9 | no | - |

## Notes

- `benchmarks/e2e-benchmark.ts` measures developer-task usefulness: expected
  file recall, returned-context precision, token volume, and current-vs-selected
  deltas.
- Positive `averageTokensVsCurrent` means the selected structural strategy used
  fewer tokens than the current hybrid comparison.
- The E2E JSON is the source of truth for acceptance checking; this page is a
  compact snapshot of the last verified local run.
