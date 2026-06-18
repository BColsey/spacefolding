# Next phases — post-Phase-0 roadmap

> Sequenced by what unblocks what, not by the original WS/Phase numbering.
> Supersedes the sequencing prose in [`NEXT-STEPS.md`](NEXT-STEPS.md) (which is
> stale — it frames WS0.6 as unstarted; WS0.6 has largely landed). For
> per-workstream detail and the risk register, see
> [`IMPLEMENTATION-PLAN.md`](IMPLEMENTATION-PLAN.md). The empirical ground truth
> is [`benchmarks/COMMIT-DERIVED-FINDINGS.md`](benchmarks/COMMIT-DERIVED-FINDINGS.md).

## Where the project stands

Phase 0 (credibility) is essentially built: hardcoded query-expansion
contamination is deleted, there is a contamination-free, commit-derived benchmark
across three languages (django/typescript/rust) with anti-leakage, a
symbol-removed ablation, paired-bootstrap 95% CIs, a *fair* file-level BM25F
baseline, and a fixed retrieval-depth asymmetry (now depth=200, stable to 400).
The honest finding is the load-bearing fact for everything downstream: **there is
no universal win over a correctly-implemented BM25 or plain FTS/grep.** With real
GPU code embeddings (`Salesforce/SFR-Embedding-Code-400M_R`) plus recalibrated
fusion, the hybrid is *competitive* with the strongest lexical baselines and its
one durable, genuine edge is **top-1 localization** (Hits@1 / tokens-to-first-
correct-file) over FTS — an exact-identifier advantage that *collapses* under the
symbol-removed ablation. It ties or loses on recall (BM25 wins django Hits@1;
FTS is the uncapped recall@20 leader; deterministic rust structural loses recall
to both). The binding constraint: the composite acceptance gate **passes only
under the non-deterministic, investigation-only GPU code model on django+
typescript**, and fails on every CI-reproducible regime (deterministic hash, and
the general `bge` model — which actively *lowers* top-1). So the gate is honestly
informational/non-blocking and cannot block in standard CI yet.

## The binding constraint that orders everything

**The acceptance gate's PASS is regime-dependent — it holds only on the GPU
code-specific embedding model, which CI cannot run offline or deterministically.**
This single fact gates almost everything: you cannot honestly flip CI to blocking,
you cannot safely land medium-risk ranking refactors (no automated regression
net), you cannot trust a chunk-size sweep or a model re-tune, and you cannot
publish a launch claim that a first-run user will reproduce on the deterministic/
bge fallback. The highest-leverage unblock is therefore **a CI-reproducible
blocking check that enforces the true, narrow subset of the claim that holds on
the deterministic provider** (a non-regression-vs-committed-baseline guard plus
corpus-independent fairness invariants), explicitly *without* lowering thresholds
and *without* claiming GPU-only wins. That blocking gate is the safety net that
makes every subsequent change safe. (Lowering the bar to force green is
explicitly disallowed by `ci.yml` and `IMPLEMENTATION-PLAN.md`.)

Note the counter-intuitive corollary, which constrains the model phases: a
*better general* embedding model (bge) makes the hybrid *worse* at top-1, because
fusion is calibrated to trust a strong vector arm. "Use a better local model" is
not a safe lever without per-model fusion recalibration.

---

## Phases

### 1. Move the CI gate onto commit-derived tasks; retire contaminated artifacts

**Goal.** Get the gate's *input* honest. CI today runs `check-acceptance.ts`
against `benchmarks/dataset.json` (the legacy self-corpus dataset, `evaluate.ts:349`),
not the commit-derived ground truth. Until the gate consumes real-commit tasks,
nothing it reports is publishable, and stale docs still present contaminated
numbers (`RESULTS.md` R@10 0.958, `E2E-RESULTS.md` recall 0.967) that downstream
readers — and the gate itself — could cite.

**Deliverables.**
- Wire `benchmarks/evaluate.ts` + `check-acceptance.ts` + `ci.yml` to run the
  deterministic-regime gate against the commit-derived task sets
  (`generate-commit-tasks.ts` output for django/typescript/rust), not legacy
  `dataset.json`.
- Pin the deterministic commit-derived numbers as a committed baseline JSON the
  gate diffs against (enables the non-regression guard in Phase 3).
- Retire/realign `benchmarks/RESULTS.md` and `benchmarks/E2E-RESULTS.md`: replace
  the 0.958/0.967 tables with depth=200 commit-derived numbers, or reduce them to
  a redirect at `COMMIT-DERIVED-FINDINGS.md`. Sweep stale 0.958/0.967 citations
  out of `LARGE-REPO-HELDOUT.md`, `ABLATION-GPU.md`, `MODEL-COMPARISON.md`.
- Fix the `paired-bootstrap.ts:105` pair parser: `pair.split('-')` +
  `[a,b]` silently mis-splits `path-match`/`symbol-only` into a non-existent
  strategy `path`. Split on the last hyphen or an explicit delimiter, or validate
  both halves against the strategy set with a clear error; add a unit test
  contrasting `structural` vs `path-match`.
- Add a `.gitignore` rule for `*.db`/`*.db-wal`/`*.db-shm` under `benchmarks/`
  (none are currently committed — keep it that way).

**Depends on.** Nothing.

**Exit criteria.** CI's acceptance job runs the composite gate against
commit-derived tasks (3 languages) under the deterministic provider and reports
honestly; `git grep` finds zero live citations of 0.958/0.967 as current results;
`paired-bootstrap.ts --pairs structural-path-match` returns a correct contrast
(unit test green); a committed baseline JSON exists.

**Effort.** ~2–3 d.

**Risks.** Low-risk plumbing, but the deterministic commit-derived numbers will
look *worse* than the retired ones (the vector arm is ~random under the hash
provider) — this is honesty, not regression, and the gate must distinguish an
"expected deterministic FAIL" from an "unexpected regression" so it stays
informational without going silent.

### 2. Close the GPU coverage + rust gap; freeze the honest claim

**Goal.** Make the GPU-regime evidence complete and symmetric so the published
claim cannot be attacked as cherry-picked. The GPU composite PASS is shown only
on django+typescript; **rust GPU was never run**, and the rust rows in the
findings doc use the *broken* BM25 and the *truncated* 50-chunk cap. Produce the
full 3-language GPU table at fair depth with the fixed BM25F, plus the ablation,
and freeze the exact publishable wording.

**Deliverables.**
- Run the GPU code model on rust with the fixed file-level BM25F and depth=200 —
  fill the missing regime-table cell.
- Re-confirm django+typescript GPU numbers at depth=200 with the fixed baseline;
  record seeded paired-bootstrap CIs for `structural−fts` (Hits@1) and
  `structural−{bm25,fts}` (R@10/R@20). GPU is non-deterministic — report mean±CI
  over seeds/runs, not a single number.
- Run the symbol-removed ablation under GPU on all three languages and publish the
  collapse table (the top-1 edge must be *shown*, not hidden).
- Write the **frozen claim block** in `COMMIT-DERIVED-FINDINGS.md`: *"a local-first
  hybrid is competitive with the strongest lexical baselines (path-aware BM25F +
  FTS) and wins top-1 localization over FTS, but does NOT dominate a correct BM25
  on recall; no universal winner; the edge is exact-identifier top-1 and collapses
  under ablation"* — scoped explicitly to the GPU code model and the measured
  languages.
- Document GPU run reproduction (model download, non-determinism caveat, seed
  handling) for reviewers, since it is not in CI.

**Depends on.** Phase 1 (fair-depth/fixed-BM25F harness must be the gate input).

**Exit criteria.** One committed table covers all 3 languages × {keyword, bm25,
bm25body, fts, vector, structural} at depth=200 under both deterministic and GPU
regimes, plus the ablation collapse, with paired-CI annotations; the frozen claim
block exists and is consistent with every cell; rust GPU is either a reported
result or the published claim *explicitly* excludes rust with a stated reason.

**Effort.** ~1 wk (requires local GPU + model download; manual, not CI).

**Risks.** If rust GPU structural still loses recall to BM25/FTS, the claim
narrows to django+typescript (or Hits@1-only on rust) — resist burying rust; a
3-language launch that omits rust GPU invites the "you cherry-picked" critique.

### 3. Make a regime-robust subset of the gate BLOCKING in CI

**Goal.** Resolve the central binding constraint without a GPU runner and without
lowering thresholds: enforce the claim subset that holds on the CI-reproducible
deterministic provider, even though it is narrower than the full GPU composite
claim. This is the keystone — it is the regression net that makes Phases 5, 6,
and 7 safe to land.

**Deliverables.**
- Empirically determine the largest claim subset that holds deterministically
  across django+typescript (and self). Candidates: a **non-regression guard**
  (deterministic structural R@10/Hits@1 must not drop below the Phase-1 committed
  baseline by more than a pre-registered margin) and/or **corpus-independent
  fairness invariants** (BM25F ≈ bm25body within bound; retrieval depth ≥200; FTS
  is the recall@20 leader). Note: the candidate "non-inferior to BM25 on recall"
  narrow claim FAILS on rust (−0.189\*), so the blocking subset must exclude rust
  or use the non-regression form.
- Implement that subset as the **blocking** half of `check-acceptance.ts`; keep
  the full GPU composite claim as a separate **informational** half that still
  runs and reports.
- Flip `ci.yml`'s acceptance job (or a new sub-job) to `continue-on-error: false`
  for *only* the regime-robust blocking subset; replace the all-or-nothing
  non-blocking rationale with a precise statement of what is/isn't enforced.
- Add a written **decision record**: either "fund a GPU-code-model CI runner later
  (cost/benefit)" or "the blocking claim is permanently the regime-robust subset,"
  with the rust exclusion called out, and a standing warning that swapping in a
  "better" general model (bge) without re-calibrating fusion *lowers* top-1.

**Depends on.** Phase 1 (baseline JSON), Phase 2 (per-regime evidence informs
which subset is safe).

**Exit criteria.** CI has at least one acceptance check with
`continue-on-error: false` that goes red on a deliberately-introduced retrieval
regression (proven by a test PR that breaks fusion) and is green on `main`; the
blocking check runs entirely offline on the deterministic provider; the decision
record states which claim is enforced and why rust/GPU are excluded from blocking;
the diff shows thresholds held or the claim *narrowed in scope, not stringency*.

**Effort.** ~3–4 d.

**Risks.** The honest blocking subset is likely *weaker* than "beats BM25" — a
true narrow non-regression gate beats a false broad one, and that must be
accepted, not forced green. Guard against over-fitting the subset to current
corpora by using non-regression-vs-baseline plus fairness invariants rather than
an absolute superiority claim.

### 4. Storage-engine scale hardening (the "wins at scale" precondition)

**Goal.** Make the engine survive the 10k–60k-file scale the *entire* Phase-1
"where grep loses at scale" thesis rests on. Today `VectorIndex` DROPs and fully
rebuilds the `vec0` table on every init (`vector-index.ts:72`), and FTS5 is
external-content (`content='chunks'`, `content_rowid='rowid'`, `schema.ts:78-92`),
the rowid/VACUUM-corruption class. These are launch BLOCKERS for any large-repo
demo, and they must be discovered/fixed *before* Phase 6 invests in the grep
harness — a late-found storage ceiling below 60k would invalidate the positioning.

**Deliverables.**
- Fix the `vec0` full-rebuild: characterize the cost at 10k/60k files and replace
  with an incremental/persisted index that only rebuilds on dimension change, not
  every init.
- Harden FTS external-content integrity: add an integrity check + rebuild path,
  and a regression test that deletes rows + VACUUMs and asserts FTS still returns
  correct rows.
- `benchmarks/SCALE-FINDINGS.md`: ingest-and-query timing + memory at ~1k / ~10k /
  ~60k files (kubernetes at 138k commits and a large monorepo are available),
  establishing index build and retrieval are viable — or documenting the concrete
  ceiling Phase 6 must stay under.

**Depends on.** Phase 1 (can pull forward; independent of the gate). Run against
the chunk size chosen in Phase 5 if Phase 5 lands first; otherwise re-check after.

**Exit criteria.** `VectorIndex` no longer drops+rebuilds the full `vec0` table on
every init for unchanged dimensions (test-verified); FTS survives a delete+VACUUM
cycle with a passing integrity assertion; `SCALE-FINDINGS.md` reports a successful
60k-file build + retrieval with timing/memory, OR documents the concrete ceiling.

**Effort.** ~1 wk.

**Risks.** Flagged Medium/High and real blockers — if the engine cannot reach 60k
files, the "wins at scale" positioning needs a rethink *before* Phase 6. The
chunks-PK / incremental-persistence migration touches FTS and has corruption blast
radius — needs review. Incremental `vec0` persistence may need sqlite-vec features
not present; fallback is a documented rebuild-on-demand with acceptable amortized
cost.

### 5. WS0.3 ranking-logic cleanup (typed fields, commensurate merge, floor wiring)

**Goal.** Eliminate the medium-risk ranking footguns that can silently regress
retrieval quality with no test signal — safe to do now that Phase 3's blocking
non-regression gate exists to catch any regression these refactors introduce.

**Deliverables.**
- Replace stringly-typed reason matching (`retriever.ts:250-251`,
  `reason.startsWith('symbol exact match')`/`'path exact match'`) with typed
  boolean fields on `StructuralSearchResult` (`src/types/index.ts:161-167`:
  `symbolExact`/`pathExact`/`referenceExact`). The exact-identifier boost is the
  *entire* durable edge, so decoupling it from reason wording stops a structural-
  indexer reword from silently destroying Hits@1.
- Fix the `mergeRawResults` double-count (`retriever.ts:1306-1316`, called at
  `:626`): it raw-SUMS scores across the full-text + lexical source sets on
  incommensurate scales — replace with a rank-based / normalized merge.
- Wire the absolute per-source RRF relevance floor into
  `src/core/retrieval-policy.ts` (which today uses only the relative
  `scoreThresholdRatio`; the absolute floor lives only in `retriever.ts`).
- Add unit tests pinning the typed-field boost behavior and commensurate-merge
  ordering; snapshot deterministic Hits@1/R@10 on django+typescript before/after
  and assert the typed-field refactor is behavior-preserving.

**Depends on.** Phase 3 (the blocking gate is the safety net; these refactors move
real ranks).

**Exit criteria.** No reason-string prefix matching remains in the boost path
(`git grep` clean); `mergeRawResults` uses a rank-based merge with a test
asserting double-source chunks aren't score-summed; `retrieval-policy.ts` enforces
the absolute floor; all tests pass AND the Phase-3 blocking gate stays green.

**Effort.** ~3–4 d.

**Risks.** `IMPLEMENTATION-PLAN.md` explicitly wants these done with review, not
unsupervised. The commensurate-merge change can shift GPU-regime behavior the
deterministic gate can't see — re-run the Phase-2 GPU harness before/after as a
manual check.

### 6. WS0.5 — chunk-size + AST defaults from a measured sweep

**Goal.** Set chunking defaults from evidence rather than the carried-over
`chunker.ts:13` `maxTokens=2000`, and decide whether AST chunking
(`CHUNK_TREE_SITTER`, off by default) should be on — but only now that the
benchmark is trustworthy and the storage engine is hardened against the resulting
chunk count.

**Deliverables.**
- `benchmarks/CHUNK-SIZE-FINDINGS.md`: a sweep over {500, 800, 2000} `maxTokens`
  (and AST-boundary on/off) on the commit-derived tasks at depth=200 across all 3
  languages, with paired CIs on R@10/Hits@1 and token-cost-per-task.
- Change `chunker.ts` default `maxTokens` *only* if a setting is CI-backed
  non-inferior-or-better (or non-inferior at materially lower token cost); a
  negative result ("2000 stays") is a valid, documented outcome.
- De-risk the AST path off the Python `StructuralIndexer` sidecar at chunk time
  (`tree-sitter-chunker.ts`): evaluate a pure-JS tree-sitter binding; flip
  `CHUNK_TREE_SITTER` default on *only* if it doesn't regress the Phase-3 gate and
  doesn't reintroduce a chunk-time subprocess that breaks offline CI. If not
  feasible this cycle, document the sidecar failure budget + guaranteed regex
  fallback.

**Depends on.** Phase 3 (trusted gate) and Phase 4 (harden storage against the
chosen chunk count — smaller chunks raise chunk count and stress `vec0`/FTS). Runs
in parallel with Phase 5 (both depend only on 3/4).

**Exit criteria.** `CHUNK-SIZE-FINDINGS.md` exists with per-language CIs; the
chunker default is changed-with-evidence or explicitly-kept-with-evidence; an
AST-default decision is recorded with the dependency reasoning; the Phase-3 gate
stays green and E2E floors (recall ≥0.70 / precision ≥0.25 / ≤13k tokens) still
hold.

**Effort.** ~3–4 d.

**Risks.** AST-default is blocked on Python-sidecar reliability; do not flip it on
if it reintroduces a chunk-time subprocess that breaks offline CI. Do not let a
single-repo win drive the default.

### 7. WS0.4 — model verification + adaptive-strategy re-tune

**Goal.** Replace the "documented-but-unverified" shipped default model and the
stale, contaminated `getAdaptiveStrategy` heuristic with self-run evidence —
closing the gap between "what we benchmarked" and "what a user gets on first run."

**Deliverables.**
- A self-run, reproducible external file-localization eval (CoIR-style and/or
  SWE-bench-lite localization) for the shipped default
  `Salesforce/SFR-Embedding-Code-400M_R`, so the model choice rests on a self-run
  number, not the model-card desk research in `MODEL-RESEARCH.md`.
- Re-tune `src/core/query-planner.ts:194-202`: delete the stale comment citing the
  OLD contaminated ablation ("vector-only beats hybrid by 7.5–19%") and the
  `gpu → vector` routing it justifies; replace with branches derived from the
  honest commit-derived + GPU data. Respect the bge counter-result: a stronger
  general model does not safely help top-1.
- Extend the fusion sweep to produce a calibrated weight set *per candidate model*
  on a calibration/holdout split; document that the shipped 0.20/0.70/0.70 GPU
  weights are valid ONLY for the GPU code model.
- Clean-install smoke test: `download-model` fetches the default and a one-task
  retrieval sanity check reproduces a published GPU result within the documented
  non-determinism band; install docs state the regime dependence honestly.

**Depends on.** Phase 2 (needs the honest GPU regime numbers; deletes the
contaminated ablation comment the frozen claim supersedes). Independent of 3/4/5/6
— can run in parallel once Phase 2 lands.

**Exit criteria.** `query-planner.ts` cites no contaminated ablation and its
branches are justified by committed honest numbers; a self-run external eval
artifact exists and reproduces from a clean checkout (download is a documented
manual/local step, out of CI); a per-model fusion-calibration procedure is
documented; a written model decision exists.

**Effort.** ~1 wk (manual/local; model download + GPU run, out of CI).

**Risks.** If the self-run CoIR/SWE-bench number contradicts the model-card claim,
the default-model decision may need revisiting. Do NOT switch the local-fallback
model to a "better" general model without re-running per-model calibration.

### 8. Phase-1 grep head-to-head — the launch artifact

**Goal.** Build the missing agentic-grep baseline and find the repo-size crossover
empirically. This is the actual launch proof, reframed around the metric where the
edge is real: **tokens-to-first-correct-file** (the Hits@1 edge), not recall. The
honest narrative is "where grep loses" = large/monorepo scale under
token-constrained parallel subagents — and that crossover must be *found*, not
assumed.

**Deliverables.**
- Add a seeded, token-budgeted, open-sourced ripgrep baseline strategy to
  `evaluate.ts` `ALL_STRATEGIES` (no grep exists in `src/` or `benchmarks/`
  today): 3–5 multi-round ripgrep rounds that skeptics can tune, so the baseline
  can't be called rigged.
- Wire `tokens-to-first-correct-file` as a first-class harness metric alongside
  `recall@budget` at the 1k/10k/60k sizes hardened in Phase 4; run under GPU SFR
  including GPU rust, carrying the ablation column.
- Report where grep WINS (small repos) honestly, not just where it loses; the
  symbol-removed ablation must run in the same invocation so the top-1 edge cannot
  be published without its collapse shown alongside.
- (Lever) Gate-test a local cross-encoder rerank (`RerankerProvider` exists) after
  retrieval: ship it only if it improves Hits@1 (paired CI excludes 0, no recall
  loss) — else cut it and publish the negative.

**Depends on.** Phase 4 (the scale claim needs the hardened engine) and Phase 2
(frozen claim + GPU rust). Best after Phase 7 (verified shipped model) so the
head-to-head runs on the default users get.

**Exit criteria.** `evaluate.ts` has a grep strategy producing tokens-to-first-
correct-file and recall@budget at 1k/10k/60k on the Phase-4 engine, reproducible
from a clean checkout with the ablation in the same run; the hybrid wins
tokens-to-first-correct-file vs grep at ≥10k files (paired CI excludes 0) — OR no
crossover is found and that triggers a documented positioning rethink (a cheap,
honest negative). No "beats every baseline" / "structural understanding" language.

**Effort.** ~1 wk+.

**Risks.** The crossover may be absent (plain FTS/grep matches the hybrid on small
repos) — if spacefolding does not measurably win at 10k–60k, the positioning needs
another rethink, and discovering that cheaply is a feature of this phase, not a
failure. The grep baseline must be open-sourced and tunable.

### 9. Launch close-out — deps, license, MCP docs, distribution

**Goal.** Clear the non-benchmark blockers that would make a launch dishonest or
impossible. These don't affect credibility but gate the eventual ship, and are
cheap under supervision.

**Deliverables.**
- Supervised `npm audit fix` for the 5 vulns (1 critical / 2 high / 1 moderate /
  1 low) — touches lockfile/test-runner, so run the full suite after and review
  the diff.
- Resolve the LICENSE blocker: the Personal Use License (noncommercial/educational
  only) is incompatible with the frictionless-install + plugin-distribution
  strategy — record a relicense/dual-license *decision* (a business/legal call for
  the owner; surface it, don't unilaterally pick).
- Fix the wrong MCP config docs (`integration-guide.md:22` says
  `.claude/settings.json`; Claude Code uses `.mcp.json`).
- Smoke-test the npx/bin entrypoint; `npm publish` with a files allowlist and an
  auto-download of the GPU code model as the default (so the install reproduces
  the benchmarked model, closing the benchmark-vs-default gap).
- (Phase-2 follow-on, gated on the above) collapse the 12-tool surface to 2–3 +
  a composite `get_context_for_task`, and ship the hooks-driven
  SessionStart/PreCompact/PostToolUse plugin so the MCP server is the engine, not
  the interface.

**Depends on.** The audit/license/docs sub-items are independent (can run anytime,
kept here so they don't distract from the critical path). Distribution + the
plugin depend on Phase 4 (incremental re-index for invisible-fast PostToolUse) and
Phase 8 (a claim worth shipping).

**Exit criteria.** `npm audit` reports 0 critical/high (or each remaining one is
documented as un-fixable transitive); a license decision is recorded;
`integration-guide.md` references `.mcp.json`; a clean-machine install + index +
first retrieval completes under 60s and reproduces a published result on the
shipped default.

**Effort.** ~2–3 d (audit/docs); distribution + plugin larger, Phase-2 scope.

**Risks.** `npm audit fix` can break the test runner via transitive bumps — run
the suite after and be ready to pin. The relicense is an owner decision. The
benchmark-vs-default gap is real: the published win needs the GPU code model, so
the shipped default must auto-download and verify that exact model, or the
published numbers must be scoped to it and never to the deterministic/bge
fallback.

---

## Recommended order

The spine is **1 → 2 → 3**: get the gate's *input* honest (move CI off
`dataset.json` onto commit-derived tasks and kill the contaminated 0.958/0.967
artifacts), then make the GPU evidence complete and symmetric and freeze the
"no universal winner / top-1 edge" claim (including the never-run GPU rust cell),
then solve the central binding constraint by standing up a regime-robust **blocking**
subset of the gate offline on the deterministic provider — without lowering
thresholds. Phase 3 is the keystone: a true blocking non-regression gate is the
safety net that makes the medium-risk WS0.3 ranking refactors (Phase 5) and the
measured chunk/AST defaults (Phase 6) safe to land — both depend only on 3 (and 6
also on 4) and can run in parallel. **Phase 4 (storage hardening) should be pulled
forward** and run alongside 1–3, because the entire Phase-8 "wins at scale" thesis
is a scale claim and an unfixable storage ceiling must be found *before* the grep
harness is built. Phase 7 (model verification) depends only on Phase 2's GPU
numbers and parallels 3–6. Phase 8 (the grep head-to-head — the real launch proof)
needs 4 (engine), 2 (frozen claim + rust), and ideally 7 (verified default).
Phase 9 (license/deps/docs/distribution) is launch hygiene: its audit/docs
sub-items can run anytime, but real distribution waits on a claim worth shipping
(Phase 8) and the hardened engine (Phase 4). The discipline encoded throughout:
never set a default, re-tune a strategy, or refactor ranking on a benchmark you
don't yet trust — and never publish a recall or "structural understanding" win the
data doesn't support.
