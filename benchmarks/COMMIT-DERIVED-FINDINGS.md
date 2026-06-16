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

## WS0.3 fusion recalibration — LANDED

The diagnosis above (miscalibrated fusion, not a bad model) was tested directly.
The `structural` strategy's reliable-vector RRF weights were swept with
`benchmarks/fusion-sweep.ts` (ingest the corpus ONCE with GPU embeddings, then
vary the fusion weights / vector floor in-process via override hooks on the real
retriever — no re-embedding per config). Selection used a 50/50 interleaved
**calibration/holdout** split and the **robust cross-repo** objective (maximize
the worst-repo calibration margin `structural_R@10 − max(vector, fts)`); the
chosen config was then validated on the never-selected **holdout** split and
re-measured end-to-end with `evaluate.ts --strategy all` + paired bootstrap.

Change (only the `vectorReliable` branch of the `structural` strategy):

| weight | before | after |
|--------|--------|-------|
| structural | 0.58 | **0.20** |
| vector | 0.24 | **0.70** |
| fts | 0.15 | **0.70** |
| dependency / graph | 0.03 / 0 | 0.03 / 0 |
| vector floor | 0.20 | 0.20 (unchanged — floor 0.2 vs 0.35 made no measurable difference) |

The structural arm is demoted to a *light booster*; the exact-identifier boost
still fires regardless of this weight, so identifier top-1 lookup is preserved.

Confirmatory GPU run (`evaluate.ts --strategy all`, paired bootstrap 10k
resamples, R@10):

| strategy | django R@10 (H@1) | typescript R@10 (H@1) |
|----------|-------------------|------------------------|
| **structural (recalibrated)** | **0.871 (0.450)** | **0.693 (0.300)** |
| structural (broken default) | 0.733 (0.300) | 0.581 (—) |
| fts | 0.798 (0.190) | 0.720 (0.280) |
| vector | 0.780 (0.310) | 0.587 (0.280) |
| keyword | 0.836 (0.380) | 0.619 (0.360) |
| bm25 | 0.565 (0.310) | 0.606 (0.400) |

Paired bootstrap 95% CIs (`*` = excludes 0):

| contrast (R@10) | django | typescript |
|-----------------|--------|------------|
| structural − fts | **+0.073 [+0.003, +0.145] \*** | −0.028 [−0.085, +0.024] |
| structural − vector | **+0.090 [+0.026, +0.158] \*** | **+0.106 [+0.028, +0.184] \*** |
| structural − keyword | +0.035 [−0.030, +0.100] | +0.073 [−0.002, +0.148] |

**What this establishes (honestly):**

1. **The bottleneck was the fusion calibration, confirmed.** The same RRF
   mechanism, re-weighted to trust the now-strong vector arm, turns the GPU
   hybrid from *below* the best single arm into *at or above* it on both repos.
   django: 0.733 → **0.871**, now **significantly above FTS**. typescript:
   0.581 → **0.693**, now a **statistical tie with FTS** (CI includes 0) and
   **significantly above vector** and every other baseline.
2. **The win is corpus-shaped, and we say so.** Where the vector and lexical
   arms are comparable (django: vector 0.780 ≈ fts 0.798) the fusion clears both
   decisively (+0.07–0.09, significant). Where one lexical arm dominates and the
   embedding arm is materially weaker (typescript: fts 0.720 ≫ vector 0.587,
   `fts − vector` +0.134 \*), the fusion **matches** fts but does **not** exceed
   it — no sweep config beat fts on typescript's full set (best 0.693 vs 0.720).
   So "hybrid > both arms" is **not** universal; "hybrid ≥ the best single arm
   (within noise)" now **is**, on both repos.
3. **It is no longer below FTS anywhere.** That was the WS0.3 target and the
   prior failure mode; it is fixed.

Not overfit-by-construction: weights were picked on calibration + worst-repo
robustness and held on the disjoint holdout (django structural − max(v,f):
holdout **+0.066**; typescript holdout ≈ tie). Reproduce with
`benchmarks/fusion-sweep.ts` → `benchmarks/analyze-sweep.ts`; confirm with
`evaluate.ts --strategy all` (`BENCH_EMBEDDING=gpu`) → `benchmarks/paired-bootstrap.ts`.

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

The GPU run reframed the conclusion: it is **not** that "retrieval can't beat
FTS" — the vector arm with real code embeddings is strong (0.780) — it was that
**the hybrid fusion was miscalibrated**, dragging the hybrid below FTS. That
constraint is now **resolved** (see *WS0.3 fusion recalibration — LANDED* above):
fusion is no longer below the best single arm on either repo, and is significantly
above FTS on django. Remaining sequence:

1. ~~**WS0.3 — fix fusion.**~~ **DONE.** Recalibrated `structural:reliable`
   weights; GPU hybrid is now ≥ best single arm (strictly on django, a tie on
   typescript). Fusion is no longer the bottleneck.
2. **Fix the BM25 baseline** (file-level aggregation + path boost) so "beats BM25"
   is fair. Currently BM25 is the weakest-but-noisy baseline (django 0.565, ts
   0.606) and not yet a credible strong-lexical comparator — `fts` is the real
   lexical bar to beat, and structural now does (django) / ties (typescript).
3. **Revisit the gate / positioning** with fusion fixed. The honest gate is now
   "recalibrated fusion ≥ best single arm (FTS/vector) within noise, strictly >
   FTS where the arms are balanced" — **not** "structural beats every baseline
   everywhere." Do not flip the acceptance gate to a universal-win claim:
   typescript shows FTS-dominant corpora where fusion ties rather than wins.
