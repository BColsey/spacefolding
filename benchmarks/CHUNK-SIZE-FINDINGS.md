# Chunk-size + AST-default findings (WS0.5 / Phase 6)

> **Decision (evidence-backed): keep `chunker.ts` `maxTokens=2000`, and keep
> `CHUNK_TREE_SITTER` OFF by default.** Smaller chunks are a *corpus-specific*
> token-efficiency win (django, GPU) but they **regress** retrieval on
> typescript/rust, **fail the Phase-3 deterministic blocking gate**, and **erode
> the load-bearing structural−fts Hits@1 edge** that the published claim rests on.
> This is the valid "2000 stays" outcome the WS0.5 brief anticipated — not a
> forced change. The AST path is now **de-risked off the Python sidecar** via a
> pure-JS web-tree-sitter splitter (`CHUNK_TREE_SITTER=js`), shipped as an opt-in
> mechanism with a guaranteed regex fallback; it is not flipped on by default
> because AST boundaries barely fire at `maxTokens=2000` and only matter at the
> small sizes that fail the gate.

**Status:** CI-backed for the deterministic regime (all 3 languages × 3 sizes);
GPU-backed for django + typescript (the languages the published GPU claim is
scoped to — see [`FROZEN-CLAIM.md`](./FROZEN-CLAIM.md)). Reproduce via the
commands at the bottom.

## Method

- Sweep `CHUNK_MAX_TOKENS ∈ {2000, 800, 500}` (carried-over default is 2000),
  AST-boundary on/off, on the commit-derived tasks
  (`/tmp/sf-commit-{django,typescript,rust}.json`, n=100/repo) at retrieval
  `depth=200`, via `benchmarks/run-chunk-sweep.sh` →
  `benchmarks/evaluate.ts --strategy all --json`.
- **Both regimes:** the deterministic hash provider (CI-reproducible, the gate's
  regime) and the GPU code model (`Salesforce/SFR-Embedding-Code-400M_R`, cuda:1,
  `GPU_EMBEDDING_SEED=42` — the regime where the real claim lives).
- Cross-config CIs by `benchmarks/analyze-chunk-sweep.ts` (paired bootstrap,
  matched by taskId, same seeded procedure as `paired-bootstrap.ts`). `bm25`
  (file-level BM25F) is the **chunk-invariant control arm**: it concatenates a
  file's chunks back together, so it should barely move across chunk sizes —
  any large `bm25` drift is the import-block-prefix duplication artifact, flagged
  below, not signal in the focus strategy.
- **Token-cost-per-task** added to `evaluate.ts` (additive-only): per task,
  `tokensToFirstHit` = cumulative token estimate of the ranked chunk list up to
  the first chunk whose file is relevant (the tokens-to-first-correct-file
  metric), plus avg chunk tokens and total retrieved tokens.

Discipline followed: `npm run build` before every eval; the non-chunk-dependent
arms (`bm25` file-level, and `vector`/`bm25`/`keyword` byte-identical between the
det and GPU runs at a fixed size) reproduced, so deltas are signal not noise; the
GPU regime was run because the deterministic gate cannot see GPU top-1 shifts.

## The chunk-size sweep — deterministic regime (all 3 languages)

`structural` mean R@10 / Hits@1, paired contrast vs 2000 (`*` = 95% CI excludes 0):

| lang | size | R@10 | Hits@1 | ΔR@10 vs 2000 | ΔHits@1 vs 2000 |
|------|------|------|--------|---------------|-----------------|
| django | 2000 | 0.867 | 0.560 | — | — |
| django | 800  | 0.857 | 0.560 | −0.010 [−0.035,+0.010] | +0.000 [−0.030,+0.030] |
| django | 500  | 0.850 | 0.530 | −0.017 [−0.050,+0.012] | −0.030 [−0.080,+0.010] |
| typescript | 2000 | 0.554 | 0.310 | — | — |
| typescript | 800  | 0.503 | 0.310 | **−0.050 [−0.100,−0.005] \*** | +0.000 |
| typescript | 500  | 0.516 | 0.220 | −0.037 [−0.115,+0.038] | **−0.090 [−0.160,−0.030] \*** |
| rust | 2000 | 0.365 | 0.290 | — | — |
| rust | 800  | 0.378 | 0.240 | +0.014 [−0.030,+0.055] | −0.050 [−0.110,+0.010] |
| rust | 500  | 0.412 | 0.210 | +0.048 [−0.006,+0.103] | **−0.080 [−0.150,−0.010] \*** |

**Read:** in the deterministic regime, smaller chunks are **not** non-inferior for
`structural` — they significantly regress typescript R@10 (−0.050\* @800),
typescript Hits@1 (−0.090\* @500), and rust Hits@1 (−0.080\* @500). The one
positive (rust R@10 +0.048 @500) is not significant. The lexical baseline `fts`
*improves* a lot at smaller chunks (django 0.812→0.903, ts 0.662→0.736, rust
0.516→0.593 R@10), so structural's position relative to the baselines gets
**worse**, not better, as chunks shrink.

## The chunk-size sweep — GPU regime (the load-bearing one)

`structural` R@10 / Hits@1 (single seeded run; the controlled arms
`bm25`/`vector` reproduced the deterministic/published values at each size):

| lang | 2000 | 800 | 500 |
|------|------|-----|-----|
| **django** | 0.868 / 0.380 | **0.930 / 0.470** | **0.932 / 0.490** |
| **typescript** | 0.695 / 0.350 | 0.698 / 0.310 | 0.696 / 0.330 |
| rust | 0.570 / 0.150 | 0.583 / 0.200 | _(not run — see Scale note)_ |

The **load-bearing asset is the GPU `structural − fts` Hits@1 edge** (the
exact-identifier top-1 win that the FROZEN-CLAIM gate enforces). Paired 95% CI:

| lang | 2000 | 800 | 500 |
|------|------|-----|-----|
| django | +0.210 [+0.120,+0.300] \* | +0.160 [+0.060,+0.260] \* | +0.180 [+0.070,+0.290] \* |
| **typescript** | **+0.110 [+0.030,+0.190] \*** | **+0.010 [−0.070,+0.090]** | +0.010 [−0.080,+0.110] |
| rust | +0.020 [−0.040,+0.080] | +0.080 [+0.010,+0.150] \* | _(not run)_ |

**This is decisive.** The chunk-size effect on the top-1 edge is corpus-specific
in *both* directions: on django the edge survives (and absolute numbers jump — the
SFR vector arm sharpens on smaller chunks: django vector R@10 0.780→0.869); on rust
it even *emerges* (+0.020 ns → +0.080\* @800). But on **typescript the edge
collapses** from a significant +0.110\* at 2000 to a non-significant +0.010 at
800/500 — `fts` Hits@1 rises faster than `structural`. typescript is the binding
case because it is a **currently-passing gated language**: at 800/500 the composite
acceptance gate's "structural strictly beats fts on Hits@1" half would **FAIL on
typescript**, narrowing the published gated claim from {django, typescript} to
{django}. (rust gaining an edge does not offset this — rust is already excluded
from the gate.) Shrinking the default would *erode the exact asset the project's
positioning rests on* on a language that currently has it — the WS0.5 brief's
explicit no-go.

## The Phase-3 blocking gate fails at 800 and 500

The deterministic self-corpus blocking gate
(`check-acceptance.ts --blocking-subset`, the CI regression net) is **green at
2000** and **red at 800 and 500** — not on `structural` (which stays
non-inferior) but on the chunk-dependent lexical baseline arms it guards:

| metric (self-corpus) | baseline (2000) | @800 | @500 |
|----------------------|-----------------|------|------|
| structural R@10 | 0.886 (≥0.843) ✓ | 0.851 ✓ | 0.838 ✗ (−0.005) |
| structural Hits@1 | 0.526 ✓ | 0.526 ✓ | 0.526 ✓ |
| **fts Hits@1** | 0.211 | **0.053 ✗** | **0.105 ✗** |
| **bm25 R@10** | 0.724 | **0.654 ✗** | **0.570 ✗** |

`bm25` (file-level) is supposed to be chunk-invariant; its drop is the
**import-block-prefix duplication artifact** — the regex code splitter re-prepends
the import block to every sub-chunk, so smaller chunks duplicate import tokens N×
per file, distorting the file-level BM25F body. (On django this barely showed —
fewer imports — so `bm25` stayed ≈0.854; on the import-heavy TS self-corpus it is
large.) Either way, a global default change to 800/500 **trips the regression
guard**, and the discipline forbids lowering the threshold to force it green.

## Token cost — the one real win, and why it is not enough

`structural` tokens-to-first-correct-file (median) and paired ΔTTFH vs 2000:

| lang | 2000 med | 800 med | ΔTTFH(mean) @800 vs 2000 |
|------|----------|---------|--------------------------|
| django | 2198 | 961 | **−2580 [−4524,−1037] \*** |
| typescript | 6355 | 2836 | **−1478 [−2877,−95] \*** |
| rust | 4086 | 2834 | +1765 [−3370,+7231] (ns) |

At 800, `structural` reaches the first correct file in **significantly fewer
tokens** on django and typescript (median roughly halved), and avg chunk size
drops ~1500→~800 tokens. This is a genuine retrieval-efficiency win. **But** the
WS0.5 bar is "non-inferior-or-better, OR non-inferior at materially lower token
cost." Smaller chunks are **not non-inferior** (significant quality regressions
above; gate failure; edge collapse), so the token win cannot carry the change.
500 is strictly worse than 800 (bigger quality regressions, noisier token
savings), so it is not a candidate.

## Why 2000 stays (decision rationale)

1. **No CI-backed non-inferiority.** Deterministic `structural` significantly
   regresses (ts R@10 −0.050\* @800; ts Hits@1 −0.090\* @500; rust Hits@1 −0.080\*
   @500). The "non-inferior at lower token cost" lever requires non-inferiority,
   which fails.
2. **The Phase-3 blocking gate goes red** at 800/500 (fts Hits@1, bm25 R@10).
   Holding it green is non-negotiable; lowering the threshold is disallowed.
3. **The load-bearing GPU `structural − fts` Hits@1 edge collapses on
   typescript** (+0.110\* → +0.010 ns), which would narrow the published gated
   claim to django-only. Eroding the top-1 asset for a token/recall win is the
   exact trade-off the brief says to refuse.
4. **The win is corpus-specific** (django only, GPU). "Do not let a single-repo
   win drive the default" is an explicit WS0.5 risk.
5. **Smaller chunks worsen ingest at scale** (Scale note below).

### Owner-facing trade-off (surfaced, not unilaterally taken)

`maxTokens=800` is a legitimate **user-tunable** setting (`CHUNK_MAX_TOKENS=800`)
for Python-heavy, GPU-embedded repos where it both *improves* GPU `structural`
(django R@10 0.868→0.930) and halves tokens-to-first-hit. It is offered as an
opt-in, **not** as the shipped global default, because as a default it fails the
CI gate and narrows the claim on typescript. If the owner later decides the
django/token-efficiency win outweighs the typescript-claim narrowing and the
import-duplication artifact, that is a deliberate positioning call requiring a
re-pinned baseline and a re-scoped FROZEN-CLAIM — not a silent default flip.

## AST chunking — pure-JS de-risk + default decision

**Feasibility (proven).** AST chunk boundaries are now available with **no Python
sidecar and no subprocess at chunk time**, via `web-tree-sitter` (WASM runtime) +
`tree-sitter-wasms` (prebuilt grammar `.wasm`): `src/core/web-tree-sitter-chunker.ts`,
gated behind `CHUNK_TREE_SITTER=js` in `chunker.ts`. It parses python/typescript/
rust (and js/go/java) fully offline, extracts top-level node boundaries, and feeds
them through the *same* boundary→chunk machinery as the sidecar path
(`buildChunksFromSymbolRanges`, refactored out of `tree-sitter-chunker.ts`).
Validated on a 404-line django file: 6 chunks @800, 9 @500, **0 chunks split
mid-body** (the WS0.5 acceptance criterion). Every failure mode (deps absent,
grammar missing, parse error, unsupported language) returns null → **guaranteed
regex fallback**, so offline CI stays green whether or not the optional WASM deps
are installed (they are intentionally *not* added to `package.json` — the chunker
is inert until a user opts in by installing them).

**Fragility found:** the grammar ABI must match the runtime — `web-tree-sitter@0.20.8`
pairs with `tree-sitter-wasms@0.1.13` (tree-sitter 0.20.x grammars); newer
`web-tree-sitter` (0.25/0.26) fails to load these grammars (dylink ABI mismatch /
ESM `require` shim). A default-on ship would have to pin both and vendor the
`.wasm` files.

**Retrieval effect (measured): AST boundaries are a statistical tie with the
regex code splitter — no measurable benefit.** Paired `structural` jsast − regex
(matched by taskId, deterministic, 95% CI), at the gate-passing default and at the
size where AST actually fires:

| lang | size | ΔR@10 (jsast−regex) | ΔHits@1 | ΔTTFH (tokens) | avg chunk tok (js/regex) |
|------|------|---------------------|---------|----------------|--------------------------|
| django | 2000 | −0.003 [−0.015,+0.006] | +0.000 [−0.030,+0.030] | +69 (ns) | 1475 / 1490 |
| django | 800  | +0.010 [+0.000,+0.030] | −0.010 [−0.030,+0.000] | −60 (ns) | 748 / 761 |
| typescript | 2000 | +0.005 [+0.000,+0.015] | −0.010 [−0.030,+0.000] | −419 (ns) | 1741 / 1778 |
| typescript | 800  | +0.010 [−0.009,+0.030] | −0.030 [−0.070,+0.000] | +326 (ns) | 807 / 850 |

Every contrast's CI includes 0 — AST boundaries change neither retrieval quality
nor token cost, at either size or language. At 2000 this is partly because few
files split at all (regex 0.867 vs jsast 0.864 absolute on django); at 800 (where
AST fires on most files) the regex code splitter — which already breaks at
function/class regex boundaries and produces near-identical chunk sizes (748 vs
761) — captures essentially the same structure tree-sitter would. (rust AST not
run: see Scale note.)

**Decision: `CHUNK_TREE_SITTER` stays OFF by default.** Reasoning: (a) AST
boundaries provide **no measurable retrieval benefit** over the regex code
splitter — the jsast−regex contrast is a tie on R@10, Hits@1, and token cost at
both 2000 and 800 (table above); the regex splitter already breaks at
function/class boundaries; (b) at the gate-passing default `maxTokens=2000` most
files never split, so AST barely fires anyway; (c) the only size at which AST
fires broadly (≤800) is itself disqualified by the gate failure + claim erosion.
There is no regime where AST-default-on both helps and keeps the gate green. The
pure-JS mechanism is still shipped as an **opt-in that removes the sidecar
dependency** for users who run small chunks and want guaranteed clean function
boundaries (e.g. for downstream display) — strictly better than the prior
Python-only path — but the benchmark gives no retrieval reason to default it on.
The 50 MB `tree-sitter-wasms` grammar pack is the cost of a default-on ship; a
future enablement should vendor only the needed grammars (~5–8 MB).

### Sidecar failure budget + guaranteed fallback (documented, per the brief)

Both AST sources are best-effort with a hard regex fallback:
- `CHUNK_TREE_SITTER=1` (Python sidecar, `structural-indexer.py` via
  `tree_sitter_language_pack`): if Python or the package is absent, or the
  subprocess errors/times out (2 s/call), `splitCodeWithTreeSitter` returns null
  and chunking falls back to the regex code splitter. In *this* environment the
  package is **not installed**, so this path already falls back — which is why the
  benchmark/CI numbers are produced in regex-fallback mode and reproduce exactly.
- `CHUNK_TREE_SITTER=js` (pure-JS): same null-on-any-failure contract, no
  subprocess, offline.
- Default (unset): regex code splitter only. No external dependency on the chunk
  path. **This is what CI and the shipped default use.**

## Gate verification + the self-corpus freeze (owner-approved)

At the unchanged default `maxTokens=2000`:
- **E2E floors hold:** focused recall 0.767 (≥0.70), precision 0.292 (≥0.25),
  avg tokens 10297 (≤13000), no task exceeds the codebase — all green.
- **Blocking gate, product arm holds:** `structural` R@10 0.886 (≥ pinned 0.873),
  Hits@1 0.526 (= pin); `fts` 0.675 / 0.211 and `keyword` 0.838 / 0.368 are
  byte-identical to the pre-Phase-6 clean tree. The chunking off-path is provably
  byte-identical (adversarially reviewed), so the *retrieval logic* did not move.

**But the blocking gate's `bm25_recallAt10` check goes red on this branch (0.662
vs pinned 0.724, margin 0.694) — a corpus-snapshot artifact, not a regression.**
The gate ingests the **live repo tree** as its self-corpus (`benchmarks/dataset.json`
fixture). Phase 6 adds product/benchmark `.ts` source (`web-tree-sitter-chunker.ts`,
`analyze-chunk-sweep.ts`, and edits to `chunker.ts`/`tree-sitter-chunker.ts`/
`evaluate.ts`/`paired-bootstrap.ts`), which shifts the **file-level BM25F's global
IDF** and reorders a few bm25 results. Isolation: clean pre-Phase-6 HEAD bm25 R@10
= 0.706 (green); with my 2 new files removed = 0.689; full branch = 0.662 — a
diffuse effect of *adding source files*, with the product `structural` arm
unchanged throughout. (The pin 0.724 was itself stale — the repo had already
drifted to 0.706 before this work.)

This was a **pre-existing gate fragility** Phase 6 surfaced: the self-corpus
reference drifts as the repo grows, and a large-enough legitimate source addition
(here, the new `web-tree-sitter-chunker.ts` + the `chunker.ts`/`tree-sitter-chunker.ts`
edits, at n=47 files) can exceed the 0.03 margin on the file-level BM25F comparator
even with the product unchanged.

**Resolution (owner-approved): freeze the gate's self-corpus fixture.** The
blocking gate now ingests a committed `{path, content}` snapshot
(`benchmarks/fixtures/self-corpus.json`, 47 files / 389 KB, regenerated by
`benchmarks/freeze-self-corpus.ts`) via `evaluate.ts --corpus-snapshot` instead of
walking the live repo. The corpus is therefore **decoupled from repo growth** —
adding a 5 KB source file leaves `bm25` R@10 unchanged at 0.6623 (verified) — so
the reference no longer drifts; only a deliberate re-freeze + re-pin changes it.
`deterministic-baseline.json` was re-pinned **once** against the frozen corpus:
`structural` *improves* (0.873→0.886, the product bar moved up, not down), the
0.03 margin is unchanged, and only the chunk-sensitive lexical comparators settle
to their frozen-corpus values (`bm25` R@10 0.724→0.662). The blocking gate is
**green** on the frozen corpus and stays offline/deterministic. `ci.yml` and
ADR-001 updated. (The informational composite job + the E2E self-corpus job still
walk the live tree; they carry margin and are non-blocking, but freezing them too
is a cheap follow-up.)

## Scale note (discipline: re-confirm Phase-4 at the chosen size)

Smaller chunks raise chunk count (~136→~197 chunks retrieved/task on django) and
stress ingest. The rust corpus (**37,022 `.rs` files, 1.4 GB**) already ingests
pathologically slowly at 2000 (det ~66 min, GPU ~2 h per run) and worsens with
smaller chunks (det rust: 66→94→138 min at 2000→800→500). The chosen default
(2000) keeps ingest and the Phase-4 `SCALE-FINDINGS.md` envelope intact; a smaller
default would materially worsen large-repo ingest — another reason to hold 2000.
(GPU rust @2000 and @800 completed; @500 was deliberately not run — each rust
GPU config needs ~2.5 h on this corpus, and rust is excluded from the gated GPU
claim, so it is not decision-critical. The decision is settled by the
deterministic 3-language sweep + django/typescript GPU regardless.)

## Caveats

- GPU runs are single-seed; GPU Hits@1 carries ~±0.02 run-to-run noise (the django
  @2000 control drew 0.380 vs published 0.400). The django R@10 jump at 800
  (+0.062) exceeds that band and the controlled arms reproduced, so the *direction*
  is trustworthy; the exact GPU Hits@1 values are indicative, and the typescript
  edge-collapse is shown with a paired CI (which absorbs within-run variance).
- The token-cost metric uses the deterministic token estimator and the depth-200
  ranked list; it rewards both better ranking and smaller chunks, by design.

## Reproduce

```sh
npm run build
# deterministic + GPU sweeps (writes /tmp/sf-cs/{lang}-{det,gpu}-{size}.json)
benchmarks/run-chunk-sweep.sh det "2000 800 500" "django typescript rust"
benchmarks/run-chunk-sweep.sh gpu "2000 800 500" "django typescript"   # GPU regime
# cross-config CIs + token cost
npx tsx benchmarks/analyze-chunk-sweep.ts --dir /tmp/sf-cs --lang django --provider det --baseline 2000
npx tsx benchmarks/analyze-chunk-sweep.ts --dir /tmp/sf-cs --lang django --provider gpu --baseline 2000
# load-bearing edge by size
npx tsx benchmarks/paired-bootstrap.ts /tmp/sf-cs/typescript-gpu-800.json --metric hitsAt1 --pairs structural-fts
# AST on/off (needs: npm i --no-save web-tree-sitter@0.20.8 tree-sitter-wasms@0.1.13)
benchmarks/run-ast-sweep.sh det "2000 800" "django typescript"
# gates at the chosen default
BENCHMARK_RETRIEVAL_DEPTH=200 npx tsx benchmarks/evaluate.ts --strategy all --json > /tmp/eval.json
npx tsx benchmarks/check-acceptance.ts --blocking-subset --retrieval-json /tmp/eval.json
npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json > /tmp/e2e.json
npx tsx benchmarks/check-acceptance.ts --e2e-json /tmp/e2e.json
```
