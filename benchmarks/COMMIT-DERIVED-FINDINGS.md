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

## WS0.6 — BM25 baseline fix + retrieval-depth fairness fix — LANDED

Two coupled corrections to the benchmark harness, both credibility-improving and
both changing earlier conclusions. Neither touches `src/` or the deterministic
acceptance-gate logic; both are in `benchmarks/evaluate.ts`.

### 1. The old `bm25` baseline was broken; it is now a fair file-level BM25F

The previous `bm25Baseline` treated each **chunk** as a document, folded the path
into the chunk body, computed IDF at chunk granularity, and **summed** per-chunk
scores into a per-file total — biasing toward many-chunk files and diluting path
tokens. It scored 0.565 R@10 on django (far below fts 0.798), so it was not a
credible "strong lexical" comparator.

The replacement is **file-level BM25F**: document = file (all chunks of a path
concatenated), with two length-normalized fields — body (w=1) and path
(w=`pathBoost`=2.0) — file-frequency IDF, and a single k1 saturation (Lucene
non-negative variant). A `bm25body` strategy (pathBoost=0) is reported alongside
to expose the path field's contribution, so the boost is auditable, not a hidden
knob. The scorer was adversarially reviewed (math/fairness/code lenses) and
confirmed canonically correct; file-level aggregation is a fairness fix (a chunk
is invariant to how a file is split — unit-tested) not a thumb on the scale. A
deterministic path tiebreaker makes the ranking reproducible across rebuilds.

Effect (R@10): django **0.565 → 0.854**, typescript 0.606 → 0.575 (the old number
was *inflated* by the many-chunk bias). The path field barely matters —
`bm25 ≈ bm25body` everywhere (django Δ +0.005) — so the result is not propped up
by the boost.

### 2. The retriever arms were truncated at 50 chunks; the JS baselines were not

The review surfaced a binding measurement asymmetry: `fts`/`structural`/`vector`
go through the retriever capped at 50 chunks (then deduped to files), while
`bm25`/`keyword` return their full ranked file list. At 50 chunks the retriever
arms deduped to a **median of ~17–33 files** — binding recall@20 everywhere and
recall@10 on typescript — so the prior "structural beats fts" was *partly fts
truncation*, not retrieval quality. Fixed by raising the benchmark retrieval
depth to **200 chunks** (`BENCHMARK_RETRIEVAL_DEPTH`, env-overridable), enough to
clear k=20 in distinct files on every corpus. Verified **stable to depth 400**
(typescript fts R@10 identical, structural drifts ≤0.02, every paired-CI verdict
unchanged) — 200 is "deep enough," not a tuned sweet spot. `bm25` is
cap-independent and reproduces 0.854/0.575 exactly across the change.

### Corrected results — commit-derived, n=100/repo, fair depth=200

Lexical arms (`keyword`/`bm25`/`bm25body`/`fts`) are **byte-identical** between
the deterministic and GPU runs (same corpus/chunks), so the GPU table is a
controlled comparison: only `vector`/`structural` move. (rust re-measurement with
the fixed BM25 + fair depth is pending — the earlier rust rows above use the
broken BM25 and the truncated cap.)

**R@10 (Hits@1):**

| strategy | django det | django GPU | typescript det | typescript GPU |
|----------|-----------|-----------|----------------|----------------|
| **bm25** (fixed) | **0.854 (0.550)** | 0.854 (0.550) | 0.575 (0.250) | 0.575 (0.250) |
| bm25body | 0.849 (0.550) | 0.849 (0.550) | 0.567 (0.240) | 0.567 (0.240) |
| keyword | 0.836 (0.380) | 0.836 (0.380) | 0.619 (0.360) | 0.619 (0.360) |
| fts | 0.812 (0.170) | 0.812 (0.170) | 0.662 (0.240) | 0.662 (0.240) |
| vector | 0.045 (—) | 0.780 (0.310) | 0.377 (0.100) | 0.592 (0.280) |
| **structural** (hybrid) | 0.867 (0.560) | **0.868 (0.400)** | 0.554 (0.310) | **0.695 (0.350)** |

**Paired bootstrap 95% CIs vs the fixed BM25 (`*` = excludes 0):**

| contrast | metric | django GPU | typescript GPU |
|----------|--------|-----------|----------------|
| structural − bm25 | R@10 | +0.014 [−0.045,+0.075] | **+0.121 [+0.047,+0.194] \*** |
| structural − bm25 | H@1  | **−0.150 [−0.270,−0.030] \*** | +0.100 [−0.010,+0.210] |
| structural − bm25 | R@20 | **+0.052 [+0.013,+0.098] \*** | **+0.116 [+0.033,+0.200] \*** |
| structural − fts  | R@10 | +0.055 [−0.011,+0.124] | +0.033 [−0.016,+0.083] |
| structural − fts  | H@1  | **+0.230 [+0.130,+0.330] \*** | **+0.110 [+0.030,+0.190] \*** |
| structural − vector | R@10 | **+0.087 [+0.021,+0.156] \*** | **+0.103 [+0.021,+0.189] \*** |

In the deterministic (no real embeddings) regime, `structural − bm25` is a
**statistical tie on every metric and both repos** — a correctly-implemented BM25
is not beaten by structural without the vector arm.

### What this establishes (honestly)

1. **A correct BM25 is a strong baseline that structural does not dominate.** With
   real code embeddings + the recalibrated fusion, the hybrid **ties** the fixed
   BM25 on django R@10 and **loses to it on django Hits@1** (BM25 0.550 vs hybrid
   0.400, −0.150 \*). BM25 even beats *pure vector* on django R@10. The hybrid
   does win the fixed BM25 on typescript recall (+0.121/+0.116 \*) and on R@20 for
   django. **There is no universal winner — it is corpus- and metric-shaped.**
2. **The hybrid's consistent, genuine edge over fts is top-1 precision, not
   recall.** `structural − fts` is a tie on R@10/R@20 on both repos but a
   significant win on Hits@1 (+0.23 django, +0.11 ts) — the preserved
   exact-identifier lookup. Uncapped, **fts is the recall@20 leader** (django
   0.955), so the earlier "structural strictly > fts on django" no longer holds at
   a fair depth (django R@10 +0.055, ns).
3. **The WS0.3 "recalibrated fusion ≥ best single arm" claim must be narrowed.**
   It was measured against fts/vector only and at the truncated cap. Against a
   *fair* BM25 and at a fair depth, the honest claim is: *the recalibrated hybrid
   is competitive with the strongest lexical baselines and wins top-1 precision
   over fts, but does not beat a correctly-implemented BM25 across the board (BM25
   wins django Hits@1).*

### Disclosures (keep the lexical arms distinct)

- `bm25` = BM25F over file-level docs **with a length-normalized path field**;
  `fts` = SQLite FTS5 over chunk **text only** (`path UNINDEXED`); `bm25body`
  isolates the path field. They are three *distinct* lexical models, deliberately
  so — `bm25` is a stronger (path-aware) "beat-me" target than `fts`.
- Tokenizer/stopword differences: `bm25` keeps `\w` (so `snake_case` stays one
  token) with no stopword list (ubiquitous terms self-cancel via near-zero IDF);
  `fts` uses unicode61 + an explicit stopword list. Disclosed, not "fixed" — they
  model lexical matching differently by design.
- `pathBoost`=2.0 is a fixed, pre-registered round value (no canonical BM25F field
  weight exists), **not** fitted to this benchmark; `bm25body` (=0) brackets it
  and the conclusions are insensitive to it.

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
   weights; GPU hybrid is no longer below the fts/vector arms. (Note: the
   "strictly > FTS on django" part of this claim was measured at the truncated
   retrieval cap — see WS0.6 below; at a fair depth it is a tie.)
2. ~~**Fix the BM25 baseline.**~~ **DONE** (WS0.6 above). File-level BM25F + path
   field; django 0.565 → 0.854. A *correctly-implemented* BM25 is now the strong
   lexical bar, and the picture it reveals is honest and non-trivial: structural
   **ties** it deterministically, **wins** typescript recall with embeddings, but
   **loses django Hits@1** to it. Also fixed the retriever-cap asymmetry that had
   been flattering structural-vs-fts.
3. **Revisit the gate / positioning** (next). With a fair BM25 in the comparison,
   the honest framing is sharper than before: *the recalibrated hybrid is
   competitive with the strongest lexical baselines (a path-aware BM25 and fts)
   and wins top-1 precision over fts on both repos, but there is no universal
   winner — BM25 beats the hybrid on django Hits@1, structural beats BM25 on
   typescript recall.* Do **not** flip the gate to any "structural beats every
   baseline" claim. The acceptance-gate's `structuralBeatsKeyword` predicate is
   also now too weak (keyword is not the strong baseline) and should compare
   against `bm25`/`fts`.
