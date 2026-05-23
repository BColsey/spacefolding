# Benchmark Results - Spacefolding Retrieval Evaluation

Last verified: 2026-05-23

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
| Keyword | 0.667 | 0.796 | 0.838 | 0.240 | 0.155 | 0.570 | 0.525 |
| Path match | 0.392 | 0.421 | 0.421 | 0.120 | 0.070 | 0.342 | 0.358 |
| FTS | 0.483 | 0.692 | 0.867 | 0.170 | 0.130 | 0.479 | 0.471 |
| Vector | 0.117 | 0.217 | 0.450 | 0.060 | 0.055 | 0.146 | 0.202 |
| Symbol only | 0.321 | 0.638 | 0.754 | 0.130 | 0.130 | 0.369 | 0.326 |
| Structural | **0.817** | **0.983** | **1.000** | **0.320** | **0.205** | **0.816** | **0.833** |

## Acceptance Metrics

Structural retrieval currently passes the ranking acceptance gate by beating the
keyword baseline on every required metric.

| Metric | Keyword | Structural | Delta | Relative |
|--------|:-------:|:----------:|:-----:|:--------:|
| R@10 | 0.796 | **0.983** | +0.187 | +23.6% |
| NDCG@10 | 0.570 | **0.816** | +0.246 | +43.2% |
| MRR | 0.525 | **0.833** | +0.308 | +58.7% |

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
