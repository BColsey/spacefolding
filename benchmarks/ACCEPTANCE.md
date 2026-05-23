# Acceptance Gate

The local acceptance gate is split into benchmark generation and a checker so
large JSON outputs can be preserved, inspected, or compared in CI.

Generated benchmark JSON is a temporary artifact. Write it under `/tmp` and do
not commit it.

Run the TypeScript quality gate:

```sh
npm run build && npm run lint && npm test
```

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

Capture machine-readable checker output:

```sh
npx tsx benchmarks/check-acceptance.ts \
  --retrieval-json /tmp/spacefolding-eval.json \
  --e2e-json /tmp/spacefolding-e2e.json \
  --json > /tmp/spacefolding-acceptance.json
```

The checker JSON has a top-level `passed` boolean and a `checks` array. Each
check reports `passed`, `actual`, and `expected` so failures identify the
metric or missing JSON section directly.

Run autonomous measurement iterations with one hour between successful runs:

```sh
RALPH_SLEEP_SECONDS=3600 ./ralph.sh measurement codex
```

The checker fails if structural retrieval does not beat keyword on `R@10`,
`NDCG@10`, and `MRR`; if focused E2E retrieval drops below 0.95 average recall,
0.35 average precision, or exceeds 13k average tokens; if E2E recall,
precision, or average tokens regress against the current hybrid strategy; or if
any E2E task returns more tokens than the full indexed codebase.
