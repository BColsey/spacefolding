# E2E Benchmark Results - Focused Structural Retrieval

Last verified: 2026-05-25

Command:

```sh
npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json > /tmp/spacefolding-e2e.json
```

Generated benchmark JSON is a temporary artifact. Keep it under `/tmp` and do
not commit it.

## Summary

| Metric | Value | Acceptance |
|--------|:-----:|:----------:|
| Average recall | 0.950 | >= 0.950 |
| Average precision | 0.433 | >= 0.350 |
| Average tokens | 10,963.3 | <= 13,000 |
| Full codebase tokens | 41,960 | No task may exceed this |
| Average tokens vs current hybrid | 1,775.7 fewer | > 0 fewer |
| Average recall vs current hybrid | +0.317 | > 0 |
| Average precision vs current hybrid | +0.248 | > 0 |
| Tasks returning more than the codebase | 0 | 0 |

`successGate.focusedRetrievalPasses` is `true`, and
`summary.tasksReturningMoreThanCodebase` is empty for this run.

## Task Details

| Task | Name | Recall | Precision | Tokens | Chunks | More than codebase | Missed files |
|------|------|:------:|:---------:|-------:|:------:|:------------------:|--------------|
| E01 | Add OpenAI embedding provider | 1.000 | 0.600 | 7,693 | 6 | no | - |
| E02 | Wire reranker into pipeline | 1.000 | 0.600 | 7,373 | 7 | no | - |
| E03 | Add TTL-based chunk eviction | 1.000 | 0.250 | 12,285 | 11 | no | - |
| E04 | Per-file statistics in web UI | 1.000 | 0.250 | 12,329 | 12 | no | - |
| E05 | Incremental file re-ingestion | 1.000 | 0.400 | 12,985 | 7 | no | - |
| E06 | Add batch delete MCP tool | 1.000 | 0.750 | 11,662 | 6 | no | - |
| E07 | Fix budget controller overflow | 1.000 | 0.333 | 12,977 | 8 | no | - |
| E08 | Add query expansion to planner | 1.000 | 0.667 | 6,575 | 5 | no | - |
| E09 | Add compression quality metric | 1.000 | 0.333 | 12,875 | 10 | no | - |
| E10 | Add context type to web display | 0.500 | 0.143 | 12,879 | 9 | no | src/core/classifier.ts |

## Notes

- `benchmarks/e2e-benchmark.ts` measures developer-task usefulness: expected
  file recall, returned-context precision, token volume, and current-vs-selected
  deltas.
- Positive `averageTokensVsCurrent` means the selected structural strategy used
  fewer tokens than the current hybrid comparison.
- The E2E JSON is the source of truth for acceptance checking; this page is a
  compact snapshot of the last verified local run.
