# Acceptance Gate

The local acceptance gate is split into benchmark generation and a checker so
large JSON outputs can be preserved, inspected, or compared in CI.

Run the main retrieval benchmark:

```sh
npm run build
npx tsx benchmarks/evaluate.ts \
  --strategy all \
  --json > /tmp/spacefolding-eval.json
```

Run the E2E token-efficiency benchmark:

```sh
npx tsx benchmarks/e2e-benchmark.ts \
  --strategy structural \
  --json > /tmp/spacefolding-e2e.json
```

Check the gate:

```sh
npx tsx benchmarks/check-acceptance.ts \
  --retrieval-json /tmp/spacefolding-eval.json \
  --e2e-json /tmp/spacefolding-e2e.json
```

The checker fails if structural retrieval does not beat keyword on `R@10`,
`NDCG@10`, and `MRR`; if E2E recall, precision, or average tokens regress
against the current hybrid strategy; or if any E2E task returns more tokens than
the full indexed codebase.
