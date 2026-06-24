# Embedding-model verification (WS0.4 / Phase 7)

> **Decision (evidence-backed): keep `Salesforce/SFR-Embedding-Code-400M_R` as the
> shipped GPU default.** On a contamination-free, self-run comparison it is **not
> beaten** by any tested alternative on the fused `structural` strategy (all
> recall@10 contrasts are statistical ties), and it is at least as good on the
> load-bearing top-1 (Hits@1) metric — the alternatives even trend *worse* on
> typescript Hits@1. `Alibaba-NLP/gte-modernbert-base` is recorded as a viable
> **lighter** alternative (149M / 768-d vs 400M / 1024-d, CoIR-validated):
> competitive on recall, not better on top-1. No shipped-default change.

**Supersedes** the contaminated `MODEL-COMPARISON.md` (April 2026), whose
"gte-modernbert champion, +7.5% over keyword" came from the **20-task self-corpus**
— the same train-on-test contamination the project retired. This doc rests the
model choice on the **commit-derived** (external-repo, anti-leakage) benchmark.

**Status:** GPU-backed, self-run, single-seed. Reproduce via the commands at the
bottom.

## Method

- Candidates run through the **same** GPU sidecar (`sentence-transformers`,
  cuda:1, `GPU_EMBEDDING_SEED=42`, no instruction prompt, normalized embeddings)
  so the comparison is apples-to-apples: only the embedding model changes.
- Corpus = commit-derived tasks (django + typescript, the two languages the GPU
  gate claim is scoped to — see `FROZEN-CLAIM.md`), n=100/repo, chunk size 2000
  (shipped default), retrieval depth 200.
- **Controlled:** the lexical arms (`bm25` file-level BM25F, `fts`) are
  **byte-identical across all models** (same corpus/chunks) — verified below — so
  only `vector`/`structural` move and any delta is the model, not noise in the
  harness.
- Paired-bootstrap 95% CIs (matched by taskId) for each candidate − SFR.

## The comparison (R@10 / Hits@1)

| model | params / dim | django vector | django **structural** | ts vector | ts **structural** |
|-------|--------------|---------------|-----------------------|-----------|-------------------|
| **SFR-Embedding-Code-400M_R** (default) | 400M / 1024 | 0.780 / 0.310 | **0.868 / 0.380** | 0.592 / 0.280 | **0.695 / 0.350** |
| gte-modernbert-base | 149M / 768 | 0.793 / 0.270 | 0.877 / 0.400 | 0.609 / 0.240 | 0.716 / 0.290 |
| bge-m3 | 568M / 1024 | 0.726 / 0.190 | 0.877 / 0.380 | 0.541 / 0.270 | 0.702 / 0.300 |
| bge-small-en-v1.5 (local fallback) | 33M / 384 | 0.734 / 0.230 | 0.851 / 0.400 | — | — |
| _control_ `bm25` / `fts` (R@10) | — | 0.854 / 0.812 | _(identical all models)_ | 0.575 / 0.662 | _(identical all models)_ |

## Paired-bootstrap 95% CIs vs SFR (`*` = excludes 0)

| contrast | metric | django | typescript |
|----------|--------|--------|------------|
| gte − SFR | vector R@10 | +0.013 [−0.061, +0.086] | +0.017 [−0.062, +0.096] |
| gte − SFR | structural R@10 | +0.009 [−0.035, +0.053] | +0.020 [−0.022, +0.068] |
| gte − SFR | structural Hits@1 | +0.020 [−0.030, +0.080] | −0.060 [−0.130, +0.000] |
| bge-m3 − SFR | structural R@10 | +0.009 [−0.022, +0.046] | +0.007 [−0.057, +0.074] |
| bge-m3 − SFR | structural Hits@1 | +0.000 [−0.050, +0.050] | −0.050 [−0.100, +0.000] |

**Every contrast's CI includes 0 — no alternative significantly beats SFR-Code**,
on recall or top-1, on either language. Two honest reads:

1. **The fused `structural` strategy is model-robust.** It lands at ~0.87 (django)
   / ~0.70 (typescript) for *every* model, because the calibrated fusion leans on
   the strong lexical arms + the exact-identifier boost; the embedding model moves
   the standalone `vector` arm more than the fused result. So the model choice is
   lower-stakes than it looks — the hybrid absorbs model differences.
2. **SFR-Code is at least as good on top-1, the load-bearing metric.** On typescript
   Hits@1 the alternatives trend *below* SFR (gte −0.060, bge-m3 −0.050; CIs touch
   but do not exclude 0). So nothing here justifies displacing the shipped default.

## Per-model fusion calibration

The shipped fusion weights (`structural`/`vector`/`fts` = 0.20/0.70/0.70) were
calibrated **for SFR-Code** (WS0.3, on a calibration/holdout split). They are
**model-specific and must not be assumed to transfer** — the standing
counter-example is the general `bge` model, where trusting the vector arm at these
weights *lowers* top-1 (self H@1 0.425→0.325; see `COMMIT-DERIVED-FINDINGS.md` /
ADR-001). To check whether the top contender could overtake SFR with its *own*
weights, `gte-modernbert-base` was re-swept (`fusion-sweep.ts`, full grid, same
calibration/holdout split as WS0.3) and its best config validated on holdout:

**gte's own best-calibrated weights land in the same family as SFR's, and still
don't overtake.** The robust-calibration winner (maximize the worst-repo
calibration margin `struct R@10 − max(vector, fts)`) for gte is
`structural=0 / vector=0.70 / fts=0.70 / floor=0.2` — i.e. the **shipped
0.20/0.70/0.70 family** with the small structural booster zeroed (within noise;
the exact-identifier boost fires regardless of this weight). Validated on the
never-selected holdout split:

| repo | split | struct R@10 | vector | fts | margin (struct − max(v,f)) |
|------|-------|-------------|--------|-----|----------------------------|
| django | holdout | 0.898 | 0.750 | 0.772 | **+0.126** |
| typescript | holdout | 0.664 | 0.612 | 0.661 | **+0.003** |

So even with weights tuned *to gte*, the fused result stays at django ~0.90 /
typescript ~0.71 — the same place SFR reaches with the shipped weights, and on
typescript it still does **not** clear `fts` (full-set struct 0.711 vs fts 0.720).
Per-model recalibration therefore does not yield a config that would justify
switching the default to gte. The shipped 0.20/0.70/0.70 weights remain valid for
SFR-Code; the bge counter-result still stands as the reason not to assume transfer.

## Clean-install smoke test + the regime gap

`scripts/smoke-install.sh` verifies the **frictionless** install path end-to-end on
the default local model (`Xenova/bge-small-en-v1.5`, ONNX, no GPU, no Python
sidecar): `download-model` → `ingest-project` → `retrieve` surfaces the expected
files (the chunker for a "how is oversized text split" query). It **passes** — the
local path is usable.

**The honest regime gap (the benchmark-vs-default reality):** the frictionless
default is the *local `bge` regime*, which does **not** reproduce the published
numbers. The composite claim (structural strictly beats FTS on Hits@1) holds only
on the **GPU SFR code model**; on the local `bge` fallback the gate **fails**
(`FROZEN-CLAIM.md`). So a first-run user gets working retrieval but **not** the
published top-1 edge unless they enable `EMBEDDING_PROVIDER=gpu` with the SFR model
(CPU-feasible; see `docs/configuration.md` and `GPU-REPRODUCTION.md`). The published
GPU result (django structural R@10 0.868) reproduces via the GPU sidecar, which is
the reproduction path documented for reviewers.

## Caveats

- GPU runs are **single-seed** (~±0.02 Hits@1 noise); the borderline typescript
  Hits@1 contrasts could be noise. The conclusion ("no alternative significantly
  beats SFR") is robust to this — it is a *null* result, and the paired CIs absorb
  within-run variance.
- Scoped to django + typescript (the gated-claim languages) and the four models
  above. Prompt-requiring models (e.g. `SFR-Embedding-2_R`, e5) are excluded — the
  sidecar uses no instruction prompt by design (see `MODEL-RESEARCH.md`).

## Reproduce

```sh
npm run build
benchmarks/run-model-comparison.sh "sfr gte bgem3 bge" "django typescript"
npx tsx benchmarks/paired-bootstrap.ts /tmp/sf-cs/django-model-gte.json --metric hitsAt1 --pairs structural-fts
# per-model calibration
BENCH_EMBEDDING=gpu GPU_EMBEDDING_MODEL=Alibaba-NLP/gte-modernbert-base \
  npx tsx benchmarks/fusion-sweep.ts --dataset /tmp/sf-commit-django.json --corpus corpora/django --out /tmp/gte-sweep-django.json
npx tsx benchmarks/analyze-sweep.ts /tmp/gte-sweep-django.json /tmp/gte-sweep-typescript.json
# clean-install smoke (local path)
scripts/smoke-install.sh
```
