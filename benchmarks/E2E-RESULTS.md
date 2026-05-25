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
| Average recall | 0.967 | >= 0.950 |
| Average precision | 0.524 | >= 0.350 |
| Average tokens | 9,654.7 | <= 13,000 |
| Full codebase tokens | 43,075 | No task may exceed this |
| Average tokens vs current hybrid | 3,208.5 fewer | > 0 fewer |
| Average recall vs current hybrid | +0.467 | > 0 |
| Average precision vs current hybrid | +0.351 | > 0 |
| Tasks returning more than the codebase | 0 | 0 |

`successGate.focusedRetrievalPasses` is `true`, and
`summary.tasksReturningMoreThanCodebase` is empty for this run.

## Task Details

| Task | Name | Recall | Precision | Tokens | Chunks | More than codebase | Missed files |
|------|------|:------:|:---------:|-------:|:------:|:------------------:|--------------|
| E01 | Add OpenAI embedding provider | 1.000 | 0.600 | 7,422 | 6 | no | - |
| E02 | Wire reranker into pipeline | 1.000 | 0.750 | 6,979 | 6 | no | - |
| E03 | Add TTL-based chunk eviction | 1.000 | 0.250 | 12,874 | 10 | no | - |
| E04 | Per-file statistics in web UI | 1.000 | 1.000 | 6,122 | 3 | no | - |
| E05 | Incremental file re-ingestion | 1.000 | 0.400 | 11,320 | 6 | no | - |
| E06 | Add batch delete MCP tool | 1.000 | 0.750 | 11,564 | 6 | no | - |
| E07 | Fix budget controller overflow | 1.000 | 0.250 | 11,723 | 10 | no | - |
| E08 | Add query expansion to planner | 1.000 | 0.667 | 6,342 | 5 | no | - |
| E09 | Add compression quality metric | 0.667 | 0.286 | 9,487 | 7 | no | src/pipeline/orchestrator.ts |
| E10 | Add context type to web display | 1.000 | 0.286 | 12,714 | 9 | no | - |

## Notes

- `benchmarks/e2e-benchmark.ts` measures developer-task usefulness: expected
  file recall, returned-context precision, token volume, and current-vs-selected
  deltas.
- Positive `averageTokensVsCurrent` means the selected structural strategy used
  fewer tokens than the current hybrid comparison.
- The E2E JSON is the source of truth for acceptance checking; this page is a
  compact snapshot of the last verified local run.
