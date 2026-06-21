# grep vs spacefolding: tokens-to-first-correct-file across repo scale

> The launch head-to-head. An agentic **ripgrep** baseline vs spacefolding's GPU
> hybrid (`structural`), measured on the metric where the edge is real —
> **tokens-to-first-correct-file** (the cheapest path to the right file under a
> token-constrained subagent) — at 1k / 10k / 60k files. The crossover is **found,
> not assumed**: where grep wins (small repos) is reported alongside where
> spacefolding wins (scale), with paired-bootstrap CIs.

**Regime:** GPU `Salesforce/SFR-Embedding-Code-400M_R`, `cuda:1`, seed 42, retrieval
depth 200. Core matrix (django/typescript/kubernetes) complete; optional follow-ons
(same-language scale isolation on rust; the 60k kibana point; multi-seed) noted under
*Honest limitations*.

## TL;DR

**Crossover found (GPU SFR, seed 42):** grep is competitive (django, ~0.9k files) or
**wins** (typescript, ~0.7k) on tokens-to-first-correct-file at small scale; the GPU
hybrid **wins significantly at scale** (kubernetes, ~9k files, Δ −25663 tokens,
paired-bootstrap 95% CI excludes 0). The crossover sits between ~1k and ~9k files —
grep's lexical ranking dilutes as distractors grow (its tokens-to-first-correct-file
inflates from ~8.5k to ~37k), while the hybrid's chunk-level ranking holds (~12k).
grep is a genuine, strong baseline (it beats the hybrid on **Hits@1** at small scale),
not a strawman — the honest narrative is "where grep loses" = token-constrained
retrieval at large/monorepo scale.

## Why this metric (and the dual token model)

`tokens-to-first-correct-file` = the cumulative tokens an agent consumes, reading
results in rank order, before it reaches the first correct file. It is the
Hits@1 edge expressed as a *cost* — the number that matters when a parallel
subagent has a fixed context budget.

The two arms consume tokens at **different granularity**, so we report two models
for grep and are explicit about it (an adversarial review confirmed that a single
whole-file number makes the comparison unfalsifiable — see *Fairness* below):

- **structural** returns pre-isolated ~2k-token **chunks** (the relevant region);
  its `tokens-to-first-hit` is the chunk walk to the first gold chunk.
- **grep (matched-context) — the headline**: the agent skims ripgrep's matching
  lines (`matches × 60` tokens, capped at a chunk per file). This is what an agent
  using grep actually reads.
- **grep (whole-file) — secondary**: the agent opens each candidate file whole.
  Real, but it stacks the deck (whole-file vs chunk is a unit mismatch structural
  always wins); kept as the "chunk-isolation value proposition" column, not the
  headline.

## Methodology

- **grep baseline** (`benchmarks/evaluate.ts`, strategy `grep`): real vendored
  ripgrep (`@vscode/ripgrep`, reproducible from a clean checkout) over the
  **byte-identical** indexed corpus (materialized to a temp dir via
  `materializeBenchmarkCorpus`). Deterministic multi-round query reformulation
  (identifier → subtoken → prose), **gold-blind**, IDF-weighted ranking, tunable
  via `--grep-rounds` / `--grep-budget`. It is a genuine agent search, not a
  strawman — at 1k it is the *strongest* baseline on Hits@1 and Recall@10.
- **structural**: the GPU hybrid (`structural` strategy), the canonical claim from
  `benchmarks/FROZEN-CLAIM.md`.
- **Corpora**: django (capped 1k — it tops out at ~7k files) and typescript (81k
  files → the 1k/10k/60k scale axis). The `--max-files` cap is **gold-retaining**
  (every gold file survives every cap; only distractor count varies), isolating
  the pure corpus-size effect.
- **Ablation**: every config is also run with `--symbol-removed` (identifiers in
  the query replaced by behavioral placeholders) so the structural edge is
  published alongside its collapse in the **same harness**. The top-1 edge is
  identifier lookup; it must never be shown without that.
- **CIs**: paired-bootstrap 95% CI (`pairedDiffCI`) of the per-task difference
  structural − grep on tokens-to-first-correct-file, paired by taskId.

## Fairness (adversarially reviewed)

The baseline passed a 4-lens adversarial review (33 agents, 48 findings, 21
confirmed). The two load-bearing fixes, both applied:

1. **IDF in grep's ranking** — without it, ubiquitous terms in large broad files
   buried the gold file and grep Recall@10 sat *below* the naive keyword baseline.
   Now IDF-weighted (df collected by ripgrep, previously discarded).
2. **Dual token model** — whole-file-only made the crossover unfalsifiable
   (structural's ~2k-token chunks always beat whole files). The matched-context
   headline makes it findable; whole-file stays as a labeled secondary column.

Confirmed safe: gold-blindness (ranking never reads `relevant_files`), byte-
identical corpus, same `DeterministicTokenEstimator` units, deterministic
(`--sort path`, seeded), reproducible from a clean checkout.

## Results

**tokens-to-first-correct-file** (mean, null-excluded; matched-context headline for
grep, chunk-based for structural; whole-file is grep's secondary column):

| corpus (scale) | files | structural | grep(ctx) | grep(whole) | fts | Δ(s−g) [95% CI] | n |
|---|---|---|---|---|---|---|---|
| django (py) | 0.9k | 7,543 | 8,530 | 43,789 | 11,354 | +1233 [−1128..3540] | 99 |
| typescript (TS) | 0.7k | 23,546 | 14,645 | 1,057,263 | 21,763 | +11038 [5283..17103] ★ | 96 |
| kubernetes (go) | 8.8k | 12,279 | 36,815 | 989,601 | 17,029 | **−25663 [−41436..−12802] ★** | 73 |

★ = paired-bootstrap 95% CI excludes 0. Δ = structural − grep (negative ⇒ structural wins).

**Recall@10 / Hits@1 / recall@8k-budget:**

| corpus (scale) | structural R@10 / h@1 | grep R@10 / h@1 / R@8k | fts R@10 | bm25 R@10 |
|---|---|---|---|---|
| django | 0.873 / 0.380 | 0.875 / 0.640 / 0.775 | 0.802 | 0.854 |
| typescript | 0.695 / 0.330 | 0.794 / 0.460 / 0.625 | 0.679 | 0.575 |
| kubernetes | 0.546 / 0.170 | 0.466 / 0.220 / 0.386 | 0.481 | 0.508 |

**Symbol-removed ablation** (the edge must be shown alongside its collapse — the
hybrid's top-1 edge is identifier lookup, not semantic understanding):

| corpus (scale) | structural h@1 orig→ablated | grep h@1 orig→ablated |
|---|---|---|
| django | 0.380 → 0.190 | 0.640 → 0.210 |
| typescript | 0.330 → 0.120 | 0.460 → 0.410 |
| kubernetes | 0.170 → 0.100 | 0.220 → 0.120 |

## The crossover

- **~0.7k–0.9k files:** grep is competitive (django: tied, CI includes 0) or wins
  (typescript: grep −11k tokens, and grep beats the hybrid on Recall@10 *and* Hits@1).
  A genuine agent's lexical search is hard to beat when the corpus is small.
- **~9k files:** the hybrid wins on tokens-to-first-correct-file (−25.7k tokens, CI
  excludes 0) and on Recall@10. grep's tokens-to-first-correct-file has inflated
  ~4× (8.5k→37k) as its ranking dilutes across thousands of distractor files; the
  hybrid's chunk-level ranking stays focused (~12k).
- **Where grep wins, honestly:** at small scale grep often has the higher **Hits@1**
  (it ranks the exact file #1 more often). The hybrid's edge is *token efficiency at
  scale*, not universally better top-1 localization — which is why the metric is
  tokens-to-first-correct-file, not Hits@1.

## Honest limitations (read before quoting a number)

- **Scale axis is per-corpus, mixed languages** (django=python, typescript=TS,
  kubernetes=go). The 9k structural-win is on a Go codebase. Same-language scale
  isolation (rust 1k→6k) and a true 60k point (kibana, TS) are **optional follow-ons**
  — kibana is the only 60k corpus but is a depth-1 shallow clone with no commit tasks
  (`git fetch --unshallow` + regenerate tasks to enable it).
- **Single seed (42).** GPU runs carry ~±0.02 Hits@1 noise; the crossover call rests
  on the per-scale paired CI. Multi-seed confirmation is the pre-publish follow-on.
- **n varies** (73–99) — tasks where neither arm surfaced gold are excluded from the
  paired contrast (null-as-exclude, consistent with `analyze-chunk-sweep.ts`).
- The benchmark-vs-default gap applies: these are **GPU SFR** numbers; the shipped
  frictionless default (bge) does not reproduce them (`MODEL-VERIFICATION.md`).

## Reproduce

```sh
bash benchmarks/run-grep-headtohead.sh /tmp/gh2h      # GPU matrix (django+typescript 1k/10k/60k, seed 42, +ablation)
npx tsx benchmarks/analyze-grep-headtohead.ts /tmp/gh2h/*.json
```

## Honest limitations

- Single seed (42); multi-seed confirmation is the follow-on before publishing.
- rust excluded from the gated claim (no top-1 edge there; BM25 leads) — run
  separately given its ~2h/GPU-config cost.
- The benchmark-vs-default gap applies: these are **GPU SFR** numbers. The shipped
  frictionless default (bge) does not reproduce them (see `MODEL-VERIFICATION.md`).
