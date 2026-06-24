# GPU benchmark reproduction

The composite retrieval claim (structural hybrid non-inferior to the strongest
lexical baseline on recall@10 AND strictly beats FTS on Hits@1) is
**regime-dependent** — it holds on the GPU code-embedding model and **fails** on
the deterministic / `bge` regimes used in CI. GPU runs are therefore
investigation-only and never run inside GitHub Actions. This doc is the
reproduction recipe so a reviewer with a local GPU can re-derive every published
GPU number in [`COMMIT-DERIVED-FINDINGS.md`](./COMMIT-DERIVED-FINDINGS.md).

## Prerequisites

- A CUDA GPU with ≥ ~4 GB free (the model is 400M params). On the dev machine:
  RTX 2080 Ti at `cuda:1` (~10.8 GB free); `cuda:0` is often occupied.
- `torch`, `sentence-transformers`, `transformers` on the host Python.
- `Salesforce/SFR-Embedding-Code-400M_R` is fetched automatically into the HF
  cache on first run (~0.8 GB). It ships custom modeling code, so `trust_remote_code`
  is on by default (`GPU_EMBEDDING_TRUST_REMOTE_CODE=0` to opt out).

## Commands

Generate the commit-derived ground truth once per corpus (writes to `/tmp`):

```sh
npx tsx benchmarks/generate-commit-tasks.ts --repo corpora/django     --output /tmp/sf-commit-django.json     --limit 100 --max-commits 600
npx tsx benchmarks/generate-commit-tasks.ts --repo corpora/typescript --output /tmp/sf-commit-typescript.json --limit 100 --max-commits 600
npx tsx benchmarks/generate-commit-tasks.ts --repo corpora/rust       --output /tmp/sf-commit-rust.json       --limit 100 --max-commits 600
```

Run the GPU retrieval eval (one corpus at a time):

```sh
BENCH_EMBEDDING=gpu GPU_EMBEDDING_DEVICE=cuda:1 GPU_EMBEDDING_SEED=42 BENCHMARK_RETRIEVAL_DEPTH=200 \
  npx tsx benchmarks/evaluate.ts --dataset /tmp/sf-commit-django.json --corpus corpora/django --strategy all --json > /tmp/sf-gpu-django.json
```

(Repeat with the typescript / rust dataset + corpus.) For the symbol-removed
ablation:

```sh
GPU_EMBEDDING_MODEL=Salesforce/SFR-Embedding-Code-400M_R GPU_EMBEDDING_DEVICE=cuda:1 \
  npx tsx benchmarks/ablation.ts --gpu
```

> `benchmarks/ablation.ts` now defaults to SFR (was `all-mpnet-base-v2`); pin
> `GPU_EMBEDDING_MODEL` explicitly regardless.

## Determinism caveat (read before citing a single number)

GPU inference (cuDNN autotuning, floating-point atomics) is **not bit-exact**.
`scripts/gpu-embedder.py --seed` (or `GPU_EMBEDDING_SEED`) sets
`torch`/`cuda`/`cudnn` deterministic flags to **narrow** run-to-run variance, but
residual non-determinism remains. **Publishable claims must report mean ± CI over
multiple seeded runs, never a single number.** With `GPU_EMBEDDING_SEED=42` the
django run below reproduced the previously-published numbers exactly (see the
table), which is evidence the variance is small — but it is not a guarantee.

## django — reproduced (SFR, cuda:1, seed 42, depth 200, n=100)

| strategy | R@10 | R@20 | H@1 | published (COMMIT-DERIVED-FINDINGS) |
|----------|------|------|------|-------------------------------------|
| bm25 | 0.854 | 0.889 | 0.550 | 0.854 ✓ |
| bm25body | 0.849 | 0.879 | 0.550 | 0.849 ✓ |
| keyword | 0.836 | 0.883 | 0.380 | 0.836 ✓ |
| fts | 0.812 | 0.955 | 0.170 | 0.812 ✓ |
| vector | 0.780 | 0.849 | 0.310 | 0.780 ✓ |
| **structural** | **0.868** | 0.942 | **0.400** | **0.868 / 0.400** ✓ |

Lexical arms (bm25/bm25body/keyword/fts) are byte-identical to the deterministic
run (same corpus/chunks), so the GPU table is a controlled comparison: only
`vector`/`structural` move. Composite gate **meets** on django (structural R@10
0.868 ≥ bm25 0.854 non-inferior; H@1 0.400 > fts 0.170).

## typescript / rust — completed

Both reproduced with `GPU_EMBEDDING_SEED=42`. The canonical claim + paired-CI
table is in [`FROZEN-CLAIM.md`](./FROZEN-CLAIM.md); R@10 / Hits@1 summary:

| strategy | typescript | rust |
|----------|------------|------|
| bm25 | 0.575 / 0.250 | 0.554 / 0.340 |
| fts | 0.662 / 0.240 | 0.516 / 0.130 |
| vector | 0.592 / 0.280 | 0.447 / 0.120 |
| **structural** | **0.695 / 0.350** | **0.568 / 0.160** |
| **composite gate** | **PASS** | **FAIL** |

The rust GPU cell — **never run before this** — is the honest negative that
narrows the claim: on rust, structural has the best R@10 (0.568) but **BM25 wins
Hits@1 decisively** (0.340 vs 0.160), and structural does not significantly beat
FTS on Hits@1 (+0.030, CI includes 0). The composite gate therefore **fails on
rust**, so the publishable claim is scoped to **django + typescript** with rust
excluded for this stated reason (see FROZEN-CLAIM.md).
