---
title: Run Benchmarks
description: How to run Spacefolding quality gates, retrieval benchmarks, and acceptance checks.
last_updated: 2026-05-27
review_schedule: quarterly
owner: maintainers
doc_type: howto
---

# Run Benchmarks

Use this guide when you need to validate build quality, retrieval quality, or focused context efficiency.

## Run the Standard Quality Gate

```bash
npm run build
npm run lint
npm test
```

## Run Ranking Evaluation

Write generated JSON under `/tmp` so benchmark artifacts do not get committed:

```bash
npx tsx benchmarks/evaluate.ts \
  --strategy all \
  --json > /tmp/spacefolding-eval.json
```

This measures top-k ranking quality with exhaustive selection so token-budget pruning does not affect ranking metrics.

## Run Focused E2E Evaluation

```bash
npx tsx benchmarks/e2e-benchmark.ts \
  --strategy structural \
  --json > /tmp/spacefolding-e2e.json
```

This measures expected-file recall, precision, returned tokens, and whether focused retrieval returns more context than the indexed codebase.

## Check Acceptance

```bash
npx tsx benchmarks/check-acceptance.ts \
  --retrieval-json /tmp/spacefolding-eval.json \
  --e2e-json /tmp/spacefolding-e2e.json
```

The checker verifies structural ranking against keyword baselines and focused retrieval against recall, precision, and token thresholds.

## Capture Machine-Readable Acceptance Output

```bash
npx tsx benchmarks/check-acceptance.ts \
  --retrieval-json /tmp/spacefolding-eval.json \
  --e2e-json /tmp/spacefolding-e2e.json \
  --json > /tmp/spacefolding-acceptance.json
```

## Run Held-Out Evaluation

Generate a dataset from another local repository:

```bash
npx tsx benchmarks/generate-heldout.ts \
  --corpus /path/to/other/repo \
  --output /tmp/spacefolding-heldout-repo.json \
  --limit 60
```

Evaluate it:

```bash
npm run build
npx tsx benchmarks/evaluate.ts \
  --dataset /tmp/spacefolding-heldout-repo.json \
  --corpus /path/to/other/repo \
  --strategy all \
  --json > /tmp/spacefolding-heldout-eval.json
```

## Read Current Snapshots

Benchmark snapshots are point-in-time records:

- [Ranking results](../../benchmarks/RESULTS.md)
- [Focused E2E results](../../benchmarks/E2E-RESULTS.md)
- [Acceptance gate](../../benchmarks/ACCEPTANCE.md)
- [Held-out usage](../../benchmarks/HELDOUT.md)
- [Model comparison](../../benchmarks/MODEL-COMPARISON.md)

## Related Docs

- [Retrieval pipeline](../concepts/retrieval-pipeline.md)
- [CLI reference](../reference/cli.md)
