# Frozen retrieval claim

> **The canonical, publishable claim.** Scoped to what the data supports, with the
> corpus where it fails called out — not buried. All numbers are commit-derived,
> GPU (`Salesforce/SFR-Embedding-Code-400M_R`), retrieval depth 200, n=100
> commit-derived tasks per repo, paired-bootstrap 95% CIs (2000+ resamples,
> `GPU_EMBEDDING_SEED=42`). Reproduce via [`GPU-REPRODUCTION.md`](./GPU-REPRODUCTION.md).

## The claim

A local-first hybrid (the `structural` strategy, recalibrated RRF fusion
0.20/0.70/0.70, SFR code-embedding vector arm) is **competitive with the strongest
lexical baselines on recall@10** across django, typescript, and rust, and
**significantly beats the pure vector arm on recall@10 in all three languages**.
Its one durable, genuine edge is **top-1 localization (Hits@1) over FTS**, which
**holds on django and typescript but NOT on rust**. **There is no universal
winner**: a correctly-implemented BM25F beats the hybrid on Hits@1 on django and
rust. The composite acceptance gate (non-inferior recall@10 AND strictly beats FTS
on Hits@1) therefore **passes on django + typescript and fails on rust** — the
claim is **scoped to django + typescript**, with rust excluded for a stated reason.

This is a "competitive + wins a specific edge" claim, NOT a "beats every baseline"
claim. Do not publish the latter — the data does not support it.

## The 3-language GPU table (R@10 / Hits@1)

| strategy | django | typescript | rust |
|----------|--------|------------|------|
| **structural (hybrid)** | **0.868 / 0.400** | **0.695 / 0.350** | **0.568 / 0.160** |
| bm25 (BM25F) | 0.854 / 0.550 | 0.575 / 0.250 | 0.554 / 0.340 |
| fts (FTS5) | 0.812 / 0.170 | 0.662 / 0.240 | 0.516 / 0.130 |
| vector (SFR) | 0.780 / 0.310 | 0.592 / 0.280 | 0.447 / 0.120 |
| keyword | 0.836 / 0.380 | 0.619 / 0.360 | 0.424 / 0.300 |
| **composite gate** | **PASS** | **PASS** | **FAIL** |

## Paired-bootstrap 95% CIs (`*` = excludes 0)

| contrast | metric | django | typescript | rust |
|----------|--------|--------|------------|------|
| structural − vector | R@10 | **+0.087 [+0.021, +0.156] \*** | **+0.103 [+0.021, +0.189] \*** | **+0.121 [+0.056, +0.191] \*** |
| structural − fts | R@10 | +0.055 [−0.011, +0.124] | +0.033 [−0.016, +0.083] | +0.052 [−0.006, +0.112] |
| structural − bm25 | R@10 | +0.014 [−0.045, +0.075] | **+0.121 [+0.047, +0.194] \*** | +0.014 [−0.054, +0.080] |
| structural − fts | H@1 | **+0.230 [+0.130, +0.330] \*** | **+0.110 [+0.030, +0.190] \*** | +0.030 [−0.030, +0.090] |
| structural − bm25 | H@1 | **−0.150 [−0.270, −0.030] \*** | +0.100 [−0.010, +0.210] | **−0.180 [−0.280, −0.080] \*** |

## What this establishes (read alongside the table)

1. **The fusion adds real value over the vector arm, everywhere.** structural −
   vector on R@10 is significantly positive in all three repos (+0.087 to +0.121,
   CIs exclude 0). Fusing lexical + structural signals onto a strong vector arm
   beats pure vector — the embedding investment + the recalibrated fusion are both
   justified.
2. **Competitive, not dominant, on recall@10.** structural is at-or-above the best
   lexical arm on R@10 in all three (ties within noise on django/rust; significantly
   above BM25 on typescript +0.121\*). It is never significantly below the best
   lexical arm on R@10.
3. **The top-1 (Hits@1) edge over FTS is the durable win — on 2 of 3 repos.**
   structural − fts on Hits@1: django +0.230\*, typescript +0.110\*; rust +0.030 (ns,
   no edge). This is the exact-identifier lookup advantage.
4. **BM25F is the top-1 leader on django and rust.** structural − bm25 on Hits@1 is
   significantly negative on django (−0.150\*) and rust (−0.180\*). A correct BM25 is
   not dominated by the hybrid.
5. **No universal winner — say so.** The hybrid wins typescript (recall + top-1 vs
   fts); it ties/wins django recall but loses django top-1 to BM25; on rust it has
   the best R@10 but loses top-1 to BM25 and the gate fails.

## Why rust is excluded from the gate

On rust, structural − fts on Hits@1 is +0.030 (CI includes 0 → no top-1 edge over
FTS), and structural − bm25 on Hits@1 is −0.180\* (BM25 is the decisive top-1
leader). The composite gate's "strictly beats FTS on Hits@1" half therefore fails.
Including rust in the claim would overstate it; excluding it — with this stated
reason — is the honest move. (Rust is also structural's weakest corpus: even the
vector arm only reaches 0.447 R@10.)

## The edge is exact-identifier lookup, not semantic understanding

Under the symbol-removed ablation the top-1 edge collapses (django structural
0.875 → 0.524; typescript 0.604 → 0.320 — see
[`COMMIT-DERIVED-FINDINGS.md`](./COMMIT-DERIVED-FINDINGS.md)). So the Hits@1 win is
identifier matching, not learned structural understanding. (GPU rust ablation is
the one remaining ablation cell; the django/typescript collapse already establishes
the mechanism.)

## Regime dependence (do not claim this on the deterministic/bge fallback)

This claim holds **only on the GPU code-embedding model**. On the deterministic
(hash) provider used in CI, the vector arm is ≈ random and the composite gate
**fails** on typescript/rust (see [`COMMIT-DERIVED-FINDINGS.md`](./COMMIT-DERIVED-FINDINGS.md)
+ [`docs/decisions/adr-001-regime-robust-blocking-gate.md`](../docs/decisions/adr-001-regime-robust-blocking-gate.md)).
On the general `bge` model, trusting the vector arm *lowers* top-1. The CI blocking
gate enforces the non-regression subset that holds deterministically — not this
GPU-regime superiority claim, which stays informational in CI.
