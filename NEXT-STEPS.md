# Next steps — post-Phase-0-credibility-fixes

> Sequenced by what unblocks what, not by the original roadmap's numbering.
> Companion to [`IMPLEMENTATION-PLAN.md`](IMPLEMENTATION-PLAN.md) — this file
> tracks *execution order*; that file holds the per-workstream detail.

## The insight that reorders everything

Phase 0 surfaced the real bottleneck: **the honest benchmark is now the
critical path.** Removing the query-expansion contamination (WS0.2) dropped
in-repo E2E recall to ~0.80 against thresholds (recall ≥ 0.95, precision ≥ 0.35)
that were reverse-engineered from the *contaminated* system. Until evaluation is
trustworthy we cannot:

- validate chunk-size / AST changes (WS0.5),
- re-tune or claim the RRF fusion win (WS0.3),
- publish any number, or
- run the Phase 1 grep head-to-head.

So the next phase is not "more retrieval features" — it is **making measurement
honest.** Everything else queues behind it.

---

## Step 1 — Honest evaluation (the critical path) · WS0.6 · ~3–4 d

Build commit-derived ground truth and recalibrate the gate.

- **Commit-derived ground truth.** A generator that mines real commits/PRs from
  the held-out corpora (`corpora/{django,kubernetes,typescript,rust,...}`):
  commit/PR/issue text as the query, files the patch touched as the relevant
  set, **excluding messages that literally name the changed files**
  (anti-leakage). Replaces the circular "where is `{symbol}` defined" template
  in `generate-heldout.ts` that lets structural win by construction.
  → `benchmarks/generate-commit-tasks.ts`
- **Symbol-removed ablation.** For each task, also evaluate a paraphrased variant
  where the exact identifier is replaced by a behavioral description. Publish the
  gap — it quantifies how much of structural's win is genuine retrieval vs.
  exact-identifier lookup.
- **Honest baseline.** Gate against **file-level BM25** (and the `fts` strategy),
  not the strawman binary keyword scorer.
- **Recalibrated thresholds.** Pre-register the E2E thresholds on a *calibration
  split* and evaluate on disjoint tasks with a noise margin — instead of the
  reverse-engineered 0.95 / 0.35 magic numbers in `check-acceptance.ts`.

**Done when:** the gate runs on real-PR tasks, survives the symbol-removed
ablation, reports per-corpus bootstrap CIs, and can be flipped to **blocking** in
CI without being dishonest. This is the deliverable that makes the project
credible.

> **External dependency / pause point:** the `corpora/*` repos are checked out as
> depth-1 shallow clones (one commit, no history). Mining commits requires
> deepening them — `git -C corpora/<repo> fetch --deepen=<N>` — a network + disk
> operation. The generator itself is built and unit-tested against
> spacefolding's *own* full git history first, so no clone is needed to land the
> code; the fetch is only needed to produce the real held-out datasets.

## Step 2 — Land Phase 0 to `main` (parallel, independent) · ~½ d

- Open the PR for `phase0-credibility-fixes`; confirm the new CI is green on the
  branch; review; merge.
- Handle the `npm audit` alerts (`npm audit fix`, then re-run tests) as part of
  this — supervised, since it touches the lockfile and test runner.

**Done when:** the credibility work is on `main` with green CI and no open
dependabot criticals. Independent of Step 1 (benchmark code vs. merge/ops) — run
them alongside each other.

## Step 3 — WS0.5 chunk-size / AST defaults (gated on Step 1) · ~2 d

- With the honest benchmark in hand, sweep chunk sizes {500, 800, 2000} and pick
  the *measured* winner.
- Turn AST chunking on by default (make the tree-sitter sidecar reliable or add a
  JS binding).

**Done when:** the default is set by data, not by the research paper alone.
Deliberately not done blind — it needs Step 1 to be measurable.

## Step 4 — WS0.3 cleanup (independent refactor) · ~1–2 d

- Replace the stringly-typed boost parsing with typed `StructuralSearchResult`
  fields.
- Remove the `mergeRawResults` double-count.
- Wire the relevance floor into `retrieval-policy.ts`.

Lower priority — correctness hardening, best done with review.

## Step 5 — WS0.4 empirical validation (needs model download) · ~1–2 d

- Download `SFR-Embedding-Code-400M`, run it against CoIR / SWE-bench
  file-localization, re-tune `getAdaptiveStrategy`.

**Done when:** the code-model default (currently shipped *documented-but-
unverified*) is confirmed or refuted on external data.

---

## Then: Phase 1 — the grep head-to-head

The actual launch artifact. Becomes possible because Steps 1–3 give a benchmark
people will believe: honest, reproducible numbers on real PRs, against BM25,
with the exact-identifier advantage ablated out.

## Recommended order

Start **Step 1**, run **Step 2 alongside** it (they don't conflict). Step 1 is
the highest-leverage work left in the project: it converts "we removed
contamination and our numbers dropped" into "here are honest, reproducible
numbers on real PRs that survive ablation" — the credibility the whole strategy
rests on.
