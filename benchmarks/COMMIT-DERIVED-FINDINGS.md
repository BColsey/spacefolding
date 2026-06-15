# Commit-derived benchmark — first honest results (WS0.6 / NEXT-STEPS Step 1)

**Status:** preliminary but CI-backed. 3 repos / 3 languages, n=100 commit-derived
tasks each. Reproducible offline from a clean checkout (after deepening the
corpora — see `COMMIT-GROUND-TRUTH.md`).

## Method

- Ground truth: real commits mined by `generate-commit-tasks.ts` — query = PR/
  commit message, relevant set = code files the patch touched. Anti-leakage
  (tasks naming a changed file dropped), size filter 1–5 files, no merges.
- Strategies from `evaluate.ts --strategy all`. **Embeddings are
  `DeterministicEmbeddingProvider` (hash-based, non-semantic)** — so `vector`
  is meaningless here (~0.04 R@10) and the production semantic-embedding arm is
  **not** exercised. This eval measures the **lexical + structural** stack only.
- Metrics: Hits@1, Hits@5, R@10, nDCG@10, MRR. Paired bootstrap 95% CIs over the
  100 tasks (2000 resamples, seeded).

## Raw queries — R@10 (Hits@1)

| strategy | django (Py) | typescript | rust |
|----------|-------------|------------|------|
| **structural** | **0.875 (0.560)** | 0.604 (0.310) | 0.377 (0.280) |
| keyword | 0.836 (0.380) | 0.619 (0.360) | 0.424 (0.300) |
| **fts** | 0.798 (0.190) | **0.720 (0.280)** | **0.517 (0.170)** |
| bm25 | 0.565 (0.310) | 0.606 (0.400) | 0.174 (0.050) |
| symbol-only | 0.587 (0.190) | 0.559 (0.320) | 0.129 (0.020) |

## Symbol-removed ablation — R@10 (orig → ablated)

| strategy | django | typescript | rust |
|----------|--------|------------|------|
| structural | 0.875 → 0.524 | 0.604 → 0.320 | 0.377 → 0.193 |
| keyword | 0.836 → 0.476 | 0.619 → 0.422 | 0.424 → 0.267 |
| fts | 0.798 → 0.513 | 0.720 → 0.584 | 0.517 → 0.384 |

## Paired bootstrap 95% CIs (`*` = excludes 0)

| contrast (R@10) | django | typescript | rust |
|-----------------|--------|------------|------|
| structural − fts | +0.077 [+0.004, +0.150] * | −0.116 [−0.194, −0.040] * | −0.140 [−0.247, −0.036] * |
| structural − keyword | +0.039 [−0.020, +0.101] | −0.015 [−0.097, +0.060] | −0.047 [−0.131, +0.035] |
| structural − fts (ablated) | +0.011 [−0.079, +0.098] | −0.264 [−0.359, −0.172] * | −0.192 [−0.272, −0.116] * |
| ablation drop (structural) | +0.351 [+0.255, +0.448] * | +0.284 [+0.196, +0.379] * | +0.185 [+0.115, +0.261] * |

## What the data says (honestly)

1. **Structural does not reliably beat FTS.** It significantly *trails* FTS on
   R@10 for typescript and rust, and only *edges* it on django (+0.077, CI lower
   bound ≈ 0). **FTS5 full-text is the most consistent strong strategy** across
   languages.
2. **Structural ≈ keyword on R@10 everywhere** (no significant difference in any
   repo).
3. **Structural's one clear win is django Hits@1 (+0.37)** — exact-identifier
   top-1 lookup. It **collapses under the symbol-removed ablation** (drop is
   large and significant in all 3 repos); under ablation structural is ≤ FTS
   everywhere. So the win is identifier matching, not semantic/structural
   understanding.
4. **The `bm25` strategy is unstable** — strong on typescript (0.606), weak on
   django (0.565) and rust (0.174). It is **not yet a fair "strong baseline"**;
   it needs file-level aggregation + a path-field boost (WS0.6) before any
   "beats BM25" claim is meaningful.
5. Structural was verified active (99–100/100 non-empty, top-10 differs from FTS
   99–100/100) — the underperformance is genuine, not a degraded index.

The numbers above use `DeterministicEmbeddingProvider` (non-semantic). The real
code-embedding arm is exercised separately below.

## Real semantic embeddings (GPU, `Salesforce/SFR-Embedding-Code-400M_R`, 1024-d)

Re-ran with `BENCH_EMBEDDING=gpu` (env-gated provider in `evaluate.ts`; the
sidecar `gpu-embedder.py` needed a `trust_remote_code` fix to load this model at
all). The lexical baselines (fts/keyword/bm25) are **byte-identical** to the
deterministic run — same corpus, same chunks — so this is a controlled
comparison: only the embedding-dependent strategies change.

django, raw queries, R@10 (Hits@1):

| strategy | deterministic | GPU (SFR-Code) |
|----------|---------------|----------------|
| vector | 0.040 (0.010) | **0.780 (0.310)** |
| structural (hybrid) | **0.875 (0.560)** | 0.733 (0.300) |
| fts | 0.798 (0.190) | 0.798 (0.190) |
| keyword | 0.836 (0.380) | 0.836 (0.380) |

Two findings:

1. **Real code embeddings fix the vector arm** — pure `vector` jumps from 0.040 to
   **0.780 R@10** (≈ FTS). The embedding investment is justified *for the vector
   strategy*.
2. **…but they make the hybrid worse.** With the high-quality vector arm trusted
   (`quality='gpu'`), the `structural` hybrid drops **0.875 → 0.733**, now *below*
   FTS (0.798) and keyword (0.836). Fusing in a genuinely-good signal *lowers* the
   result — a miscalibrated fusion (the WS0.3 RRF target). Better embeddings cannot
   become a hybrid win until fusion is fixed.

Under ablation the GPU vector arm also collapses (django structural 0.733 → 0.435,
vector 0.780 → 0.379, fts 0.798 → 0.513) — FTS stays the most robust.

**typescript confirms the pattern** (controlled — lexical baselines identical):

| strategy | deterministic | GPU (SFR-Code) |
|----------|---------------|----------------|
| vector | 0.217 (0.080) | **0.587 (0.280)** |
| structural (hybrid) | 0.604 (0.310) | 0.581 (0.240) |
| fts | 0.720 (0.280) | 0.720 (0.280) |

Real embeddings lift the vector arm (0.217 → 0.587); the hybrid again does **not**
improve (0.604 → 0.581) and stays below FTS (0.720). Same mechanism, two
languages.

## Caveats (do not over-read)

- The ablation is a **crude placeholder swap**, a directional lower bound, not an
  LLM-quality behavioral paraphrase.
- n=100/repo, single relevance definition (commit-touched files); deterministic
  run covers 3 repos, GPU run covers django (+ typescript) so far.
- GPU runs are non-deterministic and for investigation only — the acceptance gate
  stays on the deterministic provider.

## Implication for the acceptance gate

WS0.6's exit criterion was explicit: *"structural still wins on real-PR tasks
after the symbol-removed ablation, **or the positioning is revised to match what's
actually true.**"* On this evidence we are in the **second branch**. Making the
gate honest (compare against FTS/BM25, post-ablation) means it does **not** pass
as "structural beats the baseline" today — which is the correct, honest outcome,
and a strategic decision point rather than a number to re-tune.

## What changed the picture, and the next binding constraint

The GPU run reframes the conclusion. It is **not** that "retrieval can't beat
FTS" — the vector arm with real code embeddings is strong (0.780). It is that
**the hybrid fusion is miscalibrated**: adding the good vector signal *lowers* the
hybrid below FTS. So the next binding constraint is **WS0.3 (weighted RRF fusion +
relevance floor)**, not the embedding model. Sequence implied by the data:

1. **WS0.3 — fix fusion.** Re-run this exact benchmark with GPU embeddings after
   RRF lands; target: hybrid ≥ max(vector, fts), and ideally > both.
2. **Fix the BM25 baseline** (file-level aggregation + path boost) so "beats BM25"
   is fair.
3. Only then revisit the gate / positioning, with fusion no longer the bottleneck.
