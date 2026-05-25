# Benchmark Results - Spacefolding Retrieval Evaluation

Last verified: 2026-05-25

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
| Keyword | 0.692 | 0.813 | 0.871 | 0.250 | 0.160 | 0.597 | 0.575 |
| Path match | 0.392 | 0.421 | 0.421 | 0.120 | 0.070 | 0.342 | 0.358 |
| FTS | 0.433 | 0.767 | 0.883 | 0.160 | 0.145 | 0.498 | 0.449 |
| Vector | 0.158 | 0.271 | 0.483 | 0.060 | 0.055 | 0.174 | 0.238 |
| Symbol only | 0.517 | 0.671 | 0.671 | 0.220 | 0.135 | 0.428 | 0.402 |
| Structural | **0.942** | **0.958** | **1.000** | **0.390** | **0.200** | **0.896** | **0.950** |

## Acceptance Metrics

Structural retrieval currently passes the ranking acceptance gate by beating the
keyword baseline on every required metric.

| Metric | Keyword | Structural | Delta | Relative |
|--------|:-------:|:----------:|:-----:|:--------:|
| R@10 | 0.813 | **0.958** | +0.146 | +17.9% |
| NDCG@10 | 0.597 | **0.896** | +0.299 | +50.2% |
| MRR | 0.575 | **0.950** | +0.375 | +65.2% |

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
