# Large Repository Held-Out Benchmark Snapshot

Captured: 2026-05-27

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

| Corpus | Run | Keyword R@10 | Structural R@10 | Structural NDCG@10 | Structural MRR |
|--------|-----|-------------:|----------------:|-------------------:|---------------:|
| Django | 60 tasks, all strategies | 0.267 | 0.883 | 0.766 | 0.730 |
| Spring Framework | 60 tasks, all strategies | 0.233 | 0.800 | 0.663 | 0.624 |
| Rust | 60 tasks, all strategies | 0.083 | 0.633 | 0.544 | 0.517 |

Structural-only runs completed for Superset and TypeScript:

| Corpus | Run | Structural R@10 | Structural NDCG@10 | Structural MRR |
|--------|-----|----------------:|-------------------:|---------------:|
| Superset | 60 tasks, structural only | 0.833 | 0.785 | 0.774 |
| TypeScript | 60 tasks, structural only | 0.967 | 0.877 | 0.848 |

## Incomplete Evaluations

VS Code exposed the first practical scaling limit. A 60-task structural-only
run, a 20-task structural-only run, and a 5-task structural-only run were each
CPU-bound for several minutes with the output file still empty because the
benchmark emits JSON only at the end. Those attempts were terminated rather
than left as unbounded interactive jobs.

Kubernetes was tested with a 5-task structural-only dataset under:

```sh
timeout 10m npx tsx benchmarks/evaluate.ts \
  --dataset /tmp/spacefolding-heldout-kubernetes-5.json \
  --corpus corpora/kubernetes \
  --strategy structural \
  --json > /tmp/spacefolding-heldout-kubernetes-5-structural-eval.json
```

It timed out after ten minutes with no JSON report. Kibana evaluation was not
started after the VS Code and Kubernetes timeouts because the generated corpus
contains 63,399 source files and 222,701 extracted symbols.

## Findings

- The held-out dataset generator handled all eight cloned repositories across
  Python, Java, Rust, TypeScript, JavaScript, and Go.
- Structural retrieval remained strong on completed held-out runs, including
  large Java, Rust, mixed Python/TypeScript, and TypeScript corpora.
- The current benchmark harness is not interactive-friendly for larger corpora:
  it emits no progress and writes the JSON report only after the whole run
  finishes.
- Corpus source-file count alone does not predict runtime. TypeScript has only
  739 supported source files but 20,713 extracted symbols, and still took
  materially longer than expected.
- Future large-repository benchmarking should add progress logging, per-stage
  timing, resumable/partial JSON output, and an explicit task limit flag on
  `benchmarks/evaluate.ts`.
