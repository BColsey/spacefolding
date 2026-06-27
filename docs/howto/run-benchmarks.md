---
title: Run Benchmarks
description: How to run Spacefolding quality gates, retrieval benchmarks, acceptance checks, and claim protocols.
last_updated: 2026-05-27
review_schedule: quarterly
owner: maintainers
doc_type: howto
---

# Run Benchmarks

Use this guide when you need to validate build quality, retrieval quality,
focused context efficiency, or a realism-gated context-management claim.

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

Reranker reliability experiments use explicit benchmark-only structural arms.
They are accepted by `--strategy`, but are intentionally excluded from
`--strategy all`:

```bash
npx tsx benchmarks/evaluate.ts \
  --strategy structural-plain \
  --json > /tmp/spacefolding-reranker-plain.json

npx tsx benchmarks/evaluate.ts \
  --strategy structural-rerank-cross-encoder \
  --json > /tmp/spacefolding-reranker-cross-encoder.json

npx tsx benchmarks/reranker-claim-report.ts \
  --baseline /tmp/spacefolding-reranker-plain.json \
  --candidate /tmp/spacefolding-reranker-cross-encoder.json \
  --manifest benchmarks/claims/reranker-reliability.json \
  --require-confirm
```

Supported reranker arms are `structural-plain`,
`structural-rerank-deterministic`, `structural-rerank-cross-encoder`, and
`structural-rerank-oracle`.

For offline plumbing checks, set `BENCH_RERANKER_DETERMINISTIC_FALLBACK=1` on
the cross-encoder arm. The resulting report metadata sets
`fallbackDetected: true`, and `benchmarks/reranker-claim-report.ts` marks that
comparison invalid as cross-encoder evidence.

## Interpret Ranking Results

Use the ranking benchmark to answer whether retrieval is useful before an
agent spends tokens on code. Each task has one or more expected files. The
benchmark runs a strategy, ranks retrieved paths, and compares that ranked list
with the expected files.

| Metric | Read it as |
| --- | --- |
| `recallAt10` | How often the expected file appears in the first 10 retrieved paths. |
| `ndcgAt10` | Whether expected files appear near the top of the first 10 results. |
| `mrr` | How early the first expected file appears. `1.0` means rank 1. |
| `avgResults` | How broad the strategy's candidate set is before the top-k cutoffs. |

For code agents, high recall means the needed file is available. High NDCG,
MRR, and Hits@1 mean the needed file appears early enough to influence the
agent. The honest baseline is not a single keyword strawman: the composite gate
compares structural retrieval against the strongest lexical arm available in the
run (BM25F / FTS / keyword) on Recall@10, and separately requires a top-1
localization win over FTS when that claim is in scope.

When presenting results, convert recall into task counts. For example, a
`recallAt10` of `0.883` on a 60-task dataset means the strategy placed an
expected file in the first 10 results for about 53 tasks. This is usually easier
to understand than the decimal alone.

For large corpora, shard task evaluation across worker threads after the corpus
has been ingested:

```bash
npx tsx benchmarks/evaluate.ts \
  --dataset /tmp/spacefolding-heldout-repo.json \
  --corpus /path/to/other/repo \
  --strategy structural \
  --workers 10 \
  --max-chunks 1000000 \
  --json > /tmp/spacefolding-heldout-repo-structural.json
```

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

The checker verifies structural ranking against BM25F / FTS / keyword baselines
and focused retrieval against recall, precision, and token thresholds.

The retrieval half of the full composite gate is informational unless you are
running the GPU/code-embedding regime named by the claim. For local deterministic
non-regression, use the frozen blocking subset:

```bash
npx tsx benchmarks/evaluate.ts \
  --strategy all \
  --corpus-snapshot benchmarks/fixtures/self-corpus.json \
  --json > /tmp/spacefolding-eval-frozen.json

npx tsx benchmarks/check-acceptance.ts \
  --retrieval-json /tmp/spacefolding-eval-frozen.json \
  --blocking-subset
```

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
  --workers 10 \
  --max-chunks 1000000 \
  --json > /tmp/spacefolding-heldout-eval.json
```

## Run A Claim Protocol

The forward research program treats each field claim as a pre-registered
experiment: claim -> operationalization -> positive control -> realism gate ->
paired CI -> honest verdict. The manifest validator keeps that spine explicit.

Validate the current paper #2 candidate:

```bash
npx tsx benchmarks/claim-protocol.ts \
  benchmarks/claims/reranker-reliability.json
```

A claim manifest must include:

- the claim and scope;
- prior-art slots to fill during candidate discovery;
- metrics and datasets;
- a positive control proving the harness can detect the effect;
- a real-data realism gate;
- a pre-registered kill criterion;
- generated artifacts under `/tmp`;
- a verdict of `pending`, `confirm`, `debunk`, `nuance`, or `inconclusive`.

Keep claim protocol work under `benchmarks/` unless a later product decision
explicitly promotes it. Do not add MCP tools, database migrations, or runtime
commands for research controls.

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
