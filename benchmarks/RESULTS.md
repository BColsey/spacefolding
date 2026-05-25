# Benchmark Results - Spacefolding Retrieval Evaluation

Last verified: 2026-05-24

Dataset: `benchmarks/dataset.json`

Command:

```sh
npx tsx benchmarks/evaluate.ts --strategy all --json > /tmp/spacefolding-eval.json
```

Generated benchmark JSON is a temporary artifact. Keep it under `/tmp` and do
not commit it.

## Summary

| Strategy | R@5 | R@10 | R@20 | P@5 | P@10 | NDCG@10 | MRR |
|----------|:---:|:----:|:----:|:---:|:----:|:-------:|:---:|
| Keyword | 0.692 | 0.796 | 0.838 | 0.250 | 0.155 | 0.590 | 0.575 |
| Path match | 0.392 | 0.421 | 0.421 | 0.120 | 0.070 | 0.342 | 0.358 |
| FTS | 0.417 | 0.733 | 0.838 | 0.150 | 0.135 | 0.450 | 0.393 |
| Vector | 0.217 | 0.317 | 0.563 | 0.060 | 0.060 | 0.210 | 0.242 |
| Symbol only | 0.329 | 0.662 | 0.754 | 0.130 | 0.130 | 0.367 | 0.311 |
| Structural | **0.863** | **0.983** | **1.000** | **0.350** | **0.205** | **0.890** | **0.933** |

## Acceptance Metrics

Structural retrieval currently passes the ranking acceptance gate by beating the
keyword baseline on every required metric.

| Metric | Keyword | Structural | Delta | Relative |
|--------|:-------:|:----------:|:-----:|:--------:|
| R@10 | 0.796 | **0.983** | +0.187 | +23.6% |
| NDCG@10 | 0.590 | **0.890** | +0.301 | +51.0% |
| MRR | 0.575 | **0.933** | +0.358 | +62.3% |

`successGate.structuralBeatsKeyword` is `true`, and
`successGate.missingStrategySummaries` is empty for this run.

## Notes

- `benchmarks/evaluate.ts` measures ranking quality against labelled relevant
  files and uses exhaustive selection so top-k metrics are not affected by
  token-budget pruning.
- Keyword and FTS remain strong lexical baselines; structural retrieval is the
  current preferred strategy because it combines path, symbol, FTS, and vector
  signals and wins the strict gate.
- Standalone vector retrieval remains the weakest local strategy on this
  benchmark, which is why model comparisons and ablations are tracked
  separately from the deterministic acceptance gate.
