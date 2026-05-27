# Large Repository Held-Out Benchmark Snapshot

Captured: 2026-05-27
Updated: 2026-05-27 after one-hour large-corpus retries

This snapshot records shallow public repository clones used as held-out corpora
for Spacefolding retrieval testing. Generated datasets and benchmark JSON were
written under `/tmp`; the cloned corpora were kept under local-only `corpora/`
and excluded from the parent repository.

## Corpora

| Corpus | Local path | Branch | Commit | Disk | Source files | Symbols | Generated tasks | Languages |
|--------|------------|--------|--------|------|-------------:|--------:|----------------:|-----------|
| `django/django` | `corpora/django` | `main` | `0a2bc6d` | 87M | 932 | 8,241 | 60 | Python |
| `spring-projects/spring-framework` | `corpora/spring-framework` | `main` | `25e8395` | 112M | 5,224 | 34,638 | 60 | Java |
| `rust-lang/rust` | `corpora/rust` | `main` | `d1fc603d` | 463M | 6,281 | 119,159 | 60 | Rust |
| `apache/superset` | `corpora/superset` | `master` | `09a94fa` | 433M | 3,813 | 17,947 | 60 | TypeScript 41, Python 18, JavaScript 1 |
| `microsoft/vscode` | `corpora/vscode` | `main` | `4b509f76` | 823M | 7,693 | 53,965 | 60 | TypeScript 58, Rust 2 |
| `kubernetes/kubernetes` | `corpora/kubernetes` | `master` | `870565d3` | 402M | 8,779 | 67,329 | 60 | Go |
| `microsoft/TypeScript` | `corpora/typescript` | `main` | `f3d396805` | 668M | 739 | 20,713 | 60 | TypeScript |
| `elastic/kibana` | `corpora/kibana` | `main` | `5d61b52fa` | 1.8G | 63,399 | 222,701 | 60 | TypeScript 58, JavaScript 2 |

The source file and symbol counts come from `benchmarks/generate-heldout.ts`
with default test and fixture exclusions.

## Commands

Generate a 60-task held-out dataset:

```sh
npx tsx benchmarks/generate-heldout.ts \
  --corpus corpora/django \
  --output /tmp/spacefolding-heldout-django.json \
  --limit 60
```

Run the full strategy comparison:

```sh
npx tsx benchmarks/evaluate.ts \
  --dataset /tmp/spacefolding-heldout-django.json \
  --corpus corpora/django \
  --strategy all \
  --json > /tmp/spacefolding-heldout-django-eval.json
```

Run a structural-only comparison:

```sh
npx tsx benchmarks/evaluate.ts \
  --dataset /tmp/spacefolding-heldout-superset.json \
  --corpus corpora/superset \
  --strategy structural \
  --json > /tmp/spacefolding-heldout-superset-structural-eval.json
```

## Completed Evaluations

Full 60-task all-strategy runs completed for Django, Spring Framework, and
Rust. Structural retrieval beat keyword on the strict ranking metrics in all
three runs.

| Corpus | Keyword R@10 | Structural R@10 | R@10 delta | Keyword NDCG@10 | Structural NDCG@10 | NDCG delta | Keyword MRR | Structural MRR | MRR delta |
|--------|-------------:|----------------:|------------:|----------------:|-------------------:|-----------:|------------:|---------------:|----------:|
| Django | 0.267 | 0.883 | +0.617 | 0.162 | 0.766 | +0.604 | 0.147 | 0.730 | +0.583 |
| Spring Framework | 0.233 | 0.800 | +0.567 | 0.172 | 0.663 | +0.492 | 0.160 | 0.624 | +0.464 |
| Rust | 0.083 | 0.633 | +0.550 | 0.040 | 0.544 | +0.504 | 0.031 | 0.517 | +0.486 |

### All Completed Strategy Scores

| Corpus | Run | Strategy | R@10 | NDCG@10 | MRR | Avg results |
|--------|-----|----------|-----:|--------:|----:|------------:|
| Django | 60 tasks | Keyword | 0.267 | 0.162 | 0.147 | 204.4 |
| Django | 60 tasks | Path match | 0.000 | 0.000 | 0.001 | 11.7 |
| Django | 60 tasks | FTS | 0.667 | 0.412 | 0.353 | 35.2 |
| Django | 60 tasks | Vector | 0.017 | 0.007 | 0.010 | 46.6 |
| Django | 60 tasks | Symbol only | 0.800 | 0.539 | 0.469 | 89.1 |
| Django | 60 tasks | Structural | 0.883 | 0.766 | 0.730 | 32.6 |
| Spring Framework | 60 tasks | Keyword | 0.233 | 0.172 | 0.160 | 1,837.7 |
| Spring Framework | 60 tasks | Path match | 0.050 | 0.026 | 0.023 | 714.4 |
| Spring Framework | 60 tasks | FTS | 0.550 | 0.289 | 0.224 | 41.4 |
| Spring Framework | 60 tasks | Vector | 0.000 | 0.000 | 0.000 | 48.8 |
| Spring Framework | 60 tasks | Symbol only | 0.433 | 0.240 | 0.200 | 751.0 |
| Spring Framework | 60 tasks | Structural | 0.800 | 0.663 | 0.624 | 41.4 |
| Rust | 60 tasks | Keyword | 0.083 | 0.040 | 0.031 | 1,208.7 |
| Rust | 60 tasks | Path match | 0.000 | 0.000 | 0.001 | 41.7 |
| Rust | 60 tasks | FTS | 0.567 | 0.318 | 0.243 | 28.2 |
| Rust | 60 tasks | Vector | 0.033 | 0.016 | 0.015 | 45.9 |
| Rust | 60 tasks | Symbol only | 0.567 | 0.388 | 0.340 | 341.0 |
| Rust | 60 tasks | Structural | 0.633 | 0.544 | 0.517 | 18.7 |
| Superset | 60 tasks | Structural | 0.833 | 0.785 | 0.774 | 42.3 |
| TypeScript | 60 tasks | Structural | 0.967 | 0.877 | 0.848 | 17.6 |
| VS Code | 5 tasks | Structural | 0.800 | 0.726 | 0.700 | 18.6 |
| Kubernetes | 5 tasks | Structural | 0.400 | 0.400 | 0.400 | 25.2 |

Additional structural-only runs completed for Superset, TypeScript, VS Code,
and Kubernetes:

| Corpus | Run | Structural R@10 | Structural NDCG@10 | Structural MRR |
|--------|-----|----------------:|-------------------:|---------------:|
| Superset | 60 tasks, structural only | 0.833 | 0.785 | 0.774 |
| TypeScript | 60 tasks, structural only | 0.967 | 0.877 | 0.848 |
| VS Code | 5 tasks, structural only | 0.800 | 0.726 | 0.700 |
| Kubernetes | 5 tasks, structural only | 0.400 | 0.400 | 0.400 |

## Long-Running And Incomplete Evaluations

VS Code exposed the first practical scaling limit. Initial 60-task, 20-task,
and 5-task structural-only runs were CPU-bound for several minutes with the
output file still empty because the benchmark emits JSON only at the end. A
one-hour retry of the 5-task run completed.

Kubernetes was first tested with a 5-task structural-only dataset under:

```sh
timeout 10m npx tsx benchmarks/evaluate.ts \
  --dataset /tmp/spacefolding-heldout-kubernetes-5.json \
  --corpus corpora/kubernetes \
  --strategy structural \
  --json > /tmp/spacefolding-heldout-kubernetes-5-structural-eval.json
```

That ten-minute run timed out with no JSON report, but a later one-hour retry
completed. Kibana was tested with the same one-hour timeout and did not finish.

| Corpus | Dataset | Command scope | Timeout | Elapsed | Exit | Output | R@10 | NDCG@10 | MRR |
|--------|---------|---------------|---------|---------|-----:|--------|-----:|--------:|----:|
| VS Code | 5 tasks | Structural | 1h | 19:08 | 0 | JSON report | 0.800 | 0.726 | 0.700 |
| Kubernetes | 5 tasks | Structural | 1h | 28:05 | 0 | JSON report | 0.400 | 0.400 | 0.400 |
| Kibana | 5 tasks | Structural | 1h | 1:00:00 | 124 | Timed out, empty JSON | n/a | n/a | n/a |

## Findings

- The held-out dataset generator handled all eight cloned repositories across
  Python, Java, Rust, TypeScript, JavaScript, and Go.
- Structural retrieval remained strong on completed held-out runs, including
  large Java, Rust, mixed Python/TypeScript, and TypeScript corpora.
- The current benchmark harness is not interactive-friendly for larger corpora:
  it emits no progress and writes the JSON report only after the whole run
  finishes.
- A longer timeout changed the conclusion for VS Code and Kubernetes: both
  completed 5-task structural runs inside one hour, but VS Code took 19:08 and
  Kubernetes took 28:05.
- Kibana still did not complete a 5-task structural run within one hour.
- Corpus source-file count alone does not predict runtime. TypeScript has only
  739 supported source files but 20,713 extracted symbols, and still took
  materially longer than expected.
- Future large-repository benchmarking should add progress logging, per-stage
  timing, resumable/partial JSON output, and an explicit task limit flag on
  `benchmarks/evaluate.ts`.
