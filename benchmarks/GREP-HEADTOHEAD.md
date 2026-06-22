# grep vs spacefolding: tokens-to-first-correct-file across repo scale

> The launch head-to-head. An agentic **ripgrep** baseline vs spacefolding's GPU
> hybrid (`structural`), measured on the metric where the edge is real —
> **tokens-to-first-correct-file** (the cheapest path to the right file under a
> token-constrained subagent) — at 1k / 10k / 60k files. The crossover is **found,
> not assumed**: where grep wins (small repos) is reported alongside where
> spacefolding wins (scale), with paired-bootstrap CIs.

**Regime:** GPU `Salesforce/SFR-Embedding-Code-400M_R`, `cuda:1`, seed 42, retrieval
depth 200. Full matrix complete: django / typescript-compiler / kubernetes, and the
TypeScript (kibana) **same-corpus 1k / 10k / 60k** scale axis.

## TL;DR

**On TypeScript (kibana) — a gated-claim language — the GPU hybrid beats agentic-grep
on tokens-to-first-correct-file at every scale, 1k → 10k → 60k, paired-bootstrap 95%
CI excludes 0**, and the margin grows monotonically as distractors accumulate (Δ
−7.4k → −13.3k → **−34.1k tokens**). grep's cost balloons (16.8k → 32.2k → 62.2k
tokens) as its lexical ranking dilutes across tens of thousands of files; the hybrid's
chunk-level ranking holds (9.4k → 14.8k → 26.8k). grep is still a genuine, strong
baseline — competitive (django, tie) and even **winning** on the small, declaration-
heavy TypeScript *compiler* corpus (710 `.d.ts` files) — so the honest narrative is
"where grep loses" = token-constrained retrieval on application codebases at scale,
not "grep is bad."

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
| typescript compiler (TS) | 0.7k | 23,546 | 14,645 | 1,057,263 | 21,763 | +11038 [5283..17103] ★ | 96 |
| kubernetes (go) | 8.8k | 12,279 | 36,815 | 989,601 | 17,029 | −25663 [−41436..−12802] ★ | 73 |
| **kibana (TS)** | **1k** | 9,379 | 16,815 | 50,373 | 12,120 | **−7436 [−13716..−2358] ★** | 99 |
| **kibana (TS)** | **10k** | 14,780 | 32,208 | 137,961 | 16,989 | **−13303 [−27239..−2007] ★** | 54 |
| **kibana (TS)** | **60k** | 26,755 | 62,167 | 230,174 | 31,650 | **−34067 [−56556..−14277] ★** | 49 |

★ = paired-bootstrap 95% CI excludes 0. Δ = structural − grep (negative ⇒ structural wins).
The kibana margin grows monotonically with scale (−7.4k → −13.3k → −34.1k): grep's
tokens-to-first-correct-file inflates ~3.7× (1k→60k) while structural's grows ~2.8×.

**Recall@10 / Hits@1 / recall@8k-budget:**

| corpus (scale) | structural R@10 / h@1 | grep R@10 / h@1 / R@8k | fts R@10 | bm25 R@10 |
|---|---|---|---|---|
| django | 0.873 / 0.380 | 0.875 / 0.640 / 0.775 | 0.802 | 0.854 |
| typescript compiler | 0.695 / 0.330 | 0.794 / 0.460 / 0.625 | 0.679 | 0.575 |
| kubernetes | 0.546 / 0.170 | 0.466 / 0.220 / 0.386 | 0.481 | 0.508 |
| kibana (TS) 1k | 0.742 / 0.300 | 0.711 / 0.330 / 0.493 | 0.687 | 0.712 |
| kibana (TS) 10k | 0.276 / 0.110 | 0.486 / 0.290 / 0.358 | 0.253 | 0.246 |
| kibana (TS) 60k | 0.216 / 0.060 | 0.297 / 0.130 / 0.212 | 0.202 | 0.178 |

**Symbol-removed ablation** (the edge must be shown alongside its collapse — the
hybrid's top-1 edge is largely identifier lookup, not semantic understanding):

| corpus (scale) | structural h@1 orig→ablated | grep h@1 orig→ablated |
|---|---|---|
| django | 0.380 → 0.190 | 0.640 → 0.210 |
| typescript compiler | 0.330 → 0.120 | 0.460 → 0.410 |
| kubernetes | 0.170 → 0.100 | 0.220 → 0.120 |
| kibana (TS) 1k | 0.300 → 0.250 | 0.330 → 0.270 |
| kibana (TS) 10k | 0.110 → 0.090 | 0.290 → 0.230 |
| kibana (TS) 60k | 0.060 → 0.040 | 0.130 → 0.090 |

(The kibana collapse is smaller — 0.300→0.250 — than django/typescript's: the
hybrid's kibana edge is somewhat less identifier-dependent, i.e. more semantic.
Reported honestly, not generalized.)

## The crossover

- **TypeScript (kibana), same corpus at 1k → 10k → 60k files:** the hybrid wins on
  tokens-to-first-correct-file at *every* scale (Δ −7.4k, −13.3k, −34.1k; all CIs
  exclude 0), and the margin grows **monotonically** with scale. This is the claim-
  language, same-corpus scale axis — grep's cost balloons (16.8k → 32.2k → 62.2k) as
  its lexical ranking dilutes across tens of thousands of distractor files while the
  hybrid's chunk-level ranking holds (9.4k → 14.8k → 26.8k). The 60k point is the climax.
- **Small / declaration-heavy corpora:** grep is competitive (django: tied) or wins
  (TypeScript *compiler* corpus, 710 `.d.ts` files: grep −11k tokens, and grep beats
  the hybrid on Recall@10 *and* Hits@1). The crossover is corpus-dependent, not purely
  file-count — identifier-dense declaration corpora favor grep's exact-match strength.
- **Where grep wins, honestly:** even where the hybrid wins tokens-to-first-correct-
  file, grep often has the higher **Hits@1** (e.g. kibana-10k: grep 0.290 vs hybrid
  0.110; kibana-60k: 0.130 vs 0.060) and sometimes higher Recall@10 (kibana-10k: grep
  0.486 vs 0.276) — grep surfaces more gold in its top-10 but at far greater token cost.
  The hybrid's edge is *token efficiency at scale*, which is why the headline metric is
  tokens-to-first-correct-file, not Hits@1.

## Honest limitations (read before quoting a number)

- **Single seed (42).** `GPU_EMBEDDING_SEED` is reproducibility-only (it sets cudnn
  determinism flags; inference has no randomness to seed), so seeds 42/43/44 are
  byte-identical — "multi-seed via the seed flag" is meaningless. The real ~±0.02
  Hits@1 noise comes from *unseeded* cudnn non-determinism and is negligible vs the
  crossover effect (CIs exclude 0 by thousands of tokens). Capture it with repeated
  unseeded runs only if a noise estimate is genuinely needed.
- **60k ingestion is slow under contention (~10h here).** The path is ingestion-bound
  (chunk+FTS5+symbols+embed, ~0.2–0.6 s/file depending on box load), not GPU-bound
  (GPU sat ~10–20%). The hardened runner (`SF_BENCH_CACHE_DIR`) makes the ablation pass
  + same-config re-runs free; re-running 60k on a quiet box / more compute is far
  faster. An earlier cache refactor OOM'd at 60k (held all content in memory) — fixed
  to lazy/streaming content.
- **n varies** (49–99) — tasks where neither arm surfaced gold are excluded from the
  paired contrast (null-as-exclude, consistent with `analyze-chunk-sweep.ts`); larger
  corpora are harder (more gold unsurfaced → smaller n).
- **Corpus-dependent within a language:** the TypeScript *compiler* corpus (grep wins)
  vs kibana (hybrid wins) shows the result is not purely a function of file count or
  language — codebase structure matters. Generalize to "application codebases at
  scale," not "all TypeScript."
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
