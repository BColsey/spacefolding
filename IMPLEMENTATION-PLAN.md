# Spacefolding Implementation Plan

> Working plan derived from the 2026-06 deep analysis. Internal artifact — not public docs.
> Strategy spine: *become the credible, local-first context layer for where agentic grep
> provably loses — large/monorepo codebases and token-constrained parallel subagents —
> proven by a public head-to-head benchmark and delivered as an invisible Claude Code plugin.*

## Execution status (2026-06-13)

Landed and verified green (build + lint + 360 tests):
- **WS0.3 (core)** — replaced the weighted min-max score fusion in `retriever.ts`
  (`normalizeSourceResults` + `addSource`) with weighted Reciprocal Rank Fusion:
  `score(c) = Σ_source w_source / (60 + rank_source(c))`. RRF is rank-based and scale-free,
  fixing the incommensurate-score-scale problem (cosine vs BM25 vs structural integers).
  Added an absolute per-source relevance floor before ranking (vector cosine < 0.2 and
  structural/dependency ≤ 0 dropped; FTS/BM25 kept), so retrieval returns `[]` when no
  source has an above-floor hit (unit-tested). Rescaled the exact-identifier structural
  boost and the reranker fusion (`combinedScore`) to the RRF magnitude so they no longer
  dwarf multi-source agreement. `sourceScores` now reports RRF contributions; `final ==
  score`. Before/after on the in-repo deterministic-embeddings dataset: structural held/
  improved (NDCG@10 0.720→0.726, MRR 0.689→0.697; Hits@1 0.526, Hits@5 0.895, R@10 0.873
  unchanged). **WS0.3 fusion calibration — LANDED (GPU regime):** the commit-derived GPU
  benchmark showed the `structural:reliable` weights (0.58/0.24/0.15) under-used the strong
  code-embedding vector arm, dropping the hybrid below FTS. A sweep (`benchmarks/fusion-sweep.ts`,
  robust cross-repo pick on a calibration/holdout split, confirmed with `evaluate.ts --strategy
  all` + `paired-bootstrap.ts`) recalibrated them to **0.20/0.70/0.70** (floor unchanged): GPU
  hybrid is now ≥ best single arm — django structural 0.733→0.871 (− FTS +0.073 \*), typescript
  0.581→0.693 (− FTS −0.028, tie; − vector +0.106 \*). Not a universal win (FTS-dominant corpora
  tie, not beat). Null-default `setFusionWeightsOverride`/`setVectorFloorOverride` hooks added for
  the sweep. Still pending from WS0.3: typed `StructuralSearchResult` fields
  (`exactSymbolMatches`/`exactPathMatch`) to replace stringly-typed boost parsing, removing
  the `mergeRawResults` double-count, and wiring the floor into `retrieval-policy.ts`'s
  `scoreThresholdRatio`. The deterministic-structural fallback path was intentionally left
  unchanged (distinct code path for deterministic embeddings) — so the deterministic acceptance
  gate is unaffected by this recalibration.
- **WS0.2 (done)** — deleted the `TERM_EXPANSIONS` / `PHRASE_EXPANSIONS` contamination
  tables and their use in `retriever.ts`; removed the 4 unit tests that asserted the
  contaminated behavior; fixed the corrupting stemmer (`string`→`str`, `bytes`→`byt`) with a
  denylist + length guard. Added **corpus-derived query expansion** (`buildCorpusStemIndex`):
  query terms expand to the actual indexed-corpus symbols sharing their stem, fetched once via
  the shared structural cache — generalizes to any repo, no hardcoding. Recovered in-repo E2E
  focused recall 0.767→0.800, ranking unchanged.
- **WS0.1 (done)** — `.github/workflows/ci.yml`: blocking build+lint+test on every push/PR,
  plus a non-blocking acceptance-benchmark job (the E2E thresholds were calibrated on the
  contaminated system and now fail honestly at ~0.80 recall; recalibration on a calibration
  split is the WS0.6 follow-up — thresholds were NOT lowered).
- **WS0.4 (partial → default-swap done)** — added `EmbeddingQuality` to the provider
  interface and all three embedding providers; `retriever.vectorReliable` now reads it
  (fixes the minification hazard / env-vs-constructor disagreement). The recommended
  high-quality path is now the `gpu` sidecar defaulting to the code-specific
  `Salesforce/SFR-Embedding-Code-400M_R` (open weights, CPU-feasible) — changed in
  `cli/index.ts` `getDefaultEmbeddingModel()`, `pipeline/orchestrator.ts`
  `defaultEmbeddingModelForProvider()`, and the `GpuEmbeddingProvider` constructor; docs
  updated. The transformers.js `local` default stays `Xenova/bge-small-en-v1.5` as the
  lightweight ONNX fallback (no confirmed offline ONNX code model). Still pending: CoIR /
  SWE-bench-lite eval and the `getAdaptiveStrategy` re-tune (need the model download +
  benchmark run — not done in CI to keep tests offline).
- **Bug backlog** — web-server `EADDRINUSE` no longer crashes the host (added `error`
  listener); `ingest_context.type` is now a JSON-Schema enum; intent detection uses
  word-boundary matching only (dropped the substring false positives).

Done since: **WS0.6** (BM25 baseline, Hits@1/Hits@5, removed fabricated T01, unified E2E
token accounting), **WS0.3 RRF core**, **WS0.4 default**, **WS0.1 CI**, **WS0.2 corpus
expansion** — all committed/pushed to the branch.

Remaining in Phase 0 (and why deferred):
- **Acceptance-gate recalibration (WS0.1/WS0.6).** Removing the contamination dropped in-repo
  E2E focused recall to ~0.80 against thresholds (0.95/0.35) that were reverse-engineered from
  the *contaminated* system. The thresholds must be re-derived on a calibration split with
  commit-derived ground truth before the E2E gate becomes blocking. NOT lowered to force green.
- **WS0.5 chunk-size (~500) + AST-default.** A behavioral change to chunking that needs the
  recalibrated benchmark to validate (gated for the same reason RRF was) — doing it blind would
  change retrieval with no trustworthy measure. AST-default also needs the Python sidecar made
  reliable.
- **WS0.3 sub-items** — typed `StructuralSearchResult` match fields (replace stringly-typed
  boost parsing), `mergeRawResults` double-count removal, wiring the relevance floor into
  `retrieval-policy.ts`. Medium-risk ranking-logic refactors; better done with review than
  unsupervised.
- **Security:** `npm audit` reports 7 vulns (1 critical, 5 high, 1 moderate), almost all in
  dev/transitive deps (vitest→vite/esbuild; `hono` via the MCP SDK). `npm audit fix` is
  available but left for a supervised run (it touches the lockfile / test runner).
- Phase 2 storage-scale work.

## Guiding principles

1. **Credibility gates everything.** The benchmark suite is the strongest asset and the
   primary go-to-market weapon, but today its headline numbers are contaminated
   (`TERM_EXPANSIONS` tuned to this repo) and graded against a strawman. Nothing ships to
   the public until the numbers survive outside scrutiny. Phase 0 is non-negotiable and first.
2. **Every change is measured.** No tuning constant, model swap, or fusion change merges
   without a before/after on the fixed benchmark. Phase 0 builds the harness that makes this
   cheap.
3. **Fix-as-you-reposition.** The three credibility fixes (delete contamination, RRF fusion,
   code embeddings) are simultaneously the biggest real-repo quality wins. Correctness and
   strategy are the same work here.
4. **Solo-developer realism.** Phases are sequenced so each ends in a demoable, defensible
   artifact. Effort is in developer-days (d) for one engineer.

## Phase overview

| Phase | Theme | Gate to start | Exit artifact | Rough effort |
|------|-------|---------------|---------------|-------------|
| 0 | Credibility & correctness | none | Benchmark that survives a symbol-removed ablation on real-PR tasks | ~12–16 d |
| 1 | The proof | Phase 0 exit | Published grep-vs-spacefolding head-to-head on large repos | ~8–10 d |
| 2 | Invisible delivery | Phase 1 exit | npm + 2–3 tool surface + Claude Code plugin; storage survives 100k chunks | ~12–15 d |
| 3 | Durable moat | Phase 2 exit | Public reproducible leaderboard + subagent context packs | ongoing |

Phases are strictly ordered: 1 depends on 0's honest harness, 2 depends on 1's proof to be
worth installing, 3 depends on 2's distribution. The cross-cutting bug backlog (bottom) is
pulled into whichever phase first depends on the affected code.

---

## Phase 0 — Credibility & correctness (~12–16 d)

Goal: turn the retrieval stack into something that is *actually good on repos other than this
one*, and turn the benchmark into something an outside skeptic would believe.

### WS0.1 — Reproducibility + CI harness (~2 d) — do first, everything else rides on it

- Add a GitHub Actions workflow that runs `npm run build && npm run lint && npm test`, then
  the acceptance gate (`benchmarks/evaluate.ts` + `e2e-benchmark.ts` + `check-acceptance.ts`)
  on a small committed fixture corpus, on every PR.
- Commit raw benchmark JSON as CI artifacts keyed by commit SHA + a config hash (model,
  chunk size, fusion weights). Replace the hand-pasted "Last verified" dates in
  `benchmarks/RESULTS.md` / `LARGE-REPO-HELDOUT.md` with links to CI runs.
- **Exit:** a green CI badge that re-derives every published number. Acceptance:
  `check-acceptance.ts` runs in CI and fails the build on regression.

### WS0.2 — Delete benchmark contamination; corpus-derived query expansion (~3 d)

- Delete `TERM_EXPANSIONS` and `PHRASE_EXPANSIONS` (`src/core/retriever.ts:843-976`) and the
  generic auth/login→`['scorer','router']` mappings entirely.
- Replace with a corpus-derived expansion built at ingest: from `code_symbols` /
  `code_references` / path tokens, build a vocabulary (symbol names, split-identifier parts
  via the existing `splitIdentifier`/`normalizeSymbolName` in `providers/structural-indexer.ts`).
  At query time, expand `parseStructuralQuery` tokens (`src/core/query-planner.ts:95-154`) to
  the nearest corpus identifiers by prefix + bounded edit distance (and optionally
  embedding-neighbor lookup once WS0.4 lands).
- Fix the naive stemmer that corrupts terms (`retriever.ts:1024-1032`: `string`→`str`,
  `bytes`→`byt`) — use a real light stemmer (Porter) or drop stemming and rely on FTS.
- **Acceptance:** generic queries no longer resolve to this repo's symbols; a unit test
  asserts expansion of a query against a *foreign* fixture corpus produces only that corpus's
  identifiers. Re-run held-out benchmark; expect structural's absolute numbers to drop —
  that is the point, the drop is the previously-hidden contamination.

### WS0.3 — Weighted Reciprocal Rank Fusion (~2 d)

- Replace the weighted min-max sum (`normalizeSourceResults` `retriever.ts:792-810` +
  per-strategy weights) with weighted RRF: `score(c) = Σ_source w_source / (k + rank_source(c))`,
  default `k=60`. The fallback comment at `retriever.ts:257` already claims "RRF ordering" —
  make it true.
- Remove the double-counting in `mergeRawResults` (`retriever.ts:1285-1295`) where negated
  BM25 ranks are added to lexical heuristic integers — RRF makes both rank-based and
  commensurate.
- Add an **absolute relevance floor** per source (min cosine, min BM25 rank presence, min
  structural score) so retrieval can return "nothing relevant" instead of always returning
  topK. Wire this into `retrieval-policy.ts` so `scoreThresholdRatio` behaves consistently
  across strategies (it currently filters differently depending on which scale produced the
  scores).
- Replace stringly-typed boost parsing (`retriever.ts:231-233`, `680-694`) by extending
  `StructuralSearchResult` (`types/index.ts:161-167`) with typed fields
  (`exactSymbolMatches: string[]`, `exactPathMatch: boolean`) so exact-match boosts can't be
  silently lost when the reason list is capped at 6/8.
- Rebalance the reranker fusion so the fixed `+1.0` exact-structural boost no longer dwarfs
  the reranker (`retriever.ts:242`); make both contributions operate on the RRF scale.
- **Acceptance:** ranking metrics stable-or-better on the fixed held-out set; a unit test
  feeds a query with no real matches and asserts an empty result instead of topK noise.

### WS0.4 — Code-specific embedding model as the default (~2–3 d)

- The default `Xenova/bge-small-en-v1.5` (`providers/local-embedding.ts:15`,
  `cli/index.ts:177`) is a general English model. Two tracks:
  - **Local/ONNX track (DEFERRED):** no ONNX-exportable code embedding model was confirmed
    to load via `@huggingface/transformers` offline, so the transformers.js `local` default
    stays `Xenova/bge-small-en-v1.5` and is documented as the lightweight ONNX fallback
    rather than swapped to an unverified code model.
  - **Sidecar track (DONE):** `GpuEmbeddingProvider` (`providers/gpu-embedding.ts`) runs
    `sentence-transformers` and now defaults `GPU_EMBEDDING_MODEL` to
    `Salesforce/SFR-Embedding-Code-400M_R` (open weights, beats voyage-code, CPU-feasible).
    This is the recommended high-quality, local-first path. CPU mode is documented in
    `scripts/gpu-embedder.py` and `docs/configuration.md`; the default is also applied in
    `cli/index.ts` and `pipeline/orchestrator.ts`. No model is downloaded in CI/tests.
- Add `quality: 'gpu' | 'local' | 'deterministic'` to the `EmbeddingProvider` interface
  (`types/index.ts:211-214`) and have **both** `getAdaptiveStrategy` (`query-planner.ts:202`,
  env-var based) and the retriever's `vectorReliable` check (`retriever.ts:72`,
  `constructor.name` based — breaks under minification) read that single field. Removes the
  two-mechanisms-disagree bug.
- Re-tune `getAdaptiveStrategy` against the *fixed* benchmark — the current "vector-only beats
  hybrid" claim came from contaminated 20-task runs and must be re-derived.
- **Acceptance:** report retrieval recall on CoIR and SWE-bench-lite file localization for
  (deterministic / general-local / code-local / code-sidecar); code model beats general by a
  measurable margin or it doesn't ship as default.

### WS0.5 — AST chunking on by default, right-sized (~2 d)

- Make tree-sitter AST chunking the default instead of gated behind `CHUNK_TREE_SITTER=1`
  (`chunker.ts:68`, `tree-sitter-chunker.ts:17`). Requires the structural indexer to be
  reliably available — bundle/verify the tree-sitter path so it isn't a hard dependency on a
  Python sidecar at chunk time (if it must stay Python, ship a clear install check + graceful
  regex fallback, and warn loudly when falling back rather than silently).
- Drop `DEFAULT_CHUNKING_CONFIG.maxTokens` from 2000 to ~500 (`chunker.ts:13`) to match the
  200–800 token CodeRAG-Bench optimum; keep the import-block prefix behavior.
- **Acceptance:** ablation showing recall/precision at chunk sizes {500, 800, 2000} on the
  fixed benchmark; default set to the winner. Verify functions are not split mid-body on a
  fixture file.

### WS0.6 — Benchmark methodology overhaul (~3–4 d)

- **Real ground truth:** add a generator that mines commits/PRs from the held-out corpora —
  commit message or linked issue text as the query, files touched by the patch as the relevant
  set — excluding messages that literally name the changed files. Keep the existing file-level
  recall metrics. This replaces the circular "where is {symbol} defined" template
  (`generate-heldout.ts:113-134`) that makes structural retrieval win by construction.
- **Symbol-removed ablation:** for each task, also evaluate a paraphrased variant where the
  exact identifier is replaced by a behavioral description. Publish the gap — it quantifies how
  much of the structural win is genuine retrieval vs exact-identifier lookup.
- **Honest baseline:** replace the strawman binary keyword scorer (`evaluate.ts:359-386`) with
  file-level BM25 (aggregate chunk BM25 with a path-field boost) and *also* gate against the
  `fts` strategy, which already beats keyword everywhere.
- **Honest stats:** report Hits@1/Hits@5 (held-out tasks have one relevant file, so
  R@10/NDCG/MRR are near-redundant), add per-corpus bootstrap CIs, drop or quarantine n=5/n=10
  runs from headline tables, pre-register E2E thresholds on a calibration split and evaluate on
  disjoint tasks with a noise margin (replace the strict `>0` deltas at
  `e2e-benchmark.ts:494-503`).
- **Honest token accounting:** unify on `DeterministicTokenEstimator` for both codebase totals
  and retrieval totals in `e2e-benchmark.ts:269-271` (currently `words*1.3` vs estimator), and
  stop comparing a 43k-token codebase against a 50k budget as a "savings" win.
- Clean `dataset.json` (delete the fabricated T01 auth/401 task with no matching code).
- **Acceptance:** a regenerated `LARGE-REPO-HELDOUT.md` where every number has a CI link, a CI,
  and a confidence interval; structural still wins on real-PR tasks *after* the symbol-removed
  ablation, or the positioning is revised to match what's actually true.

### Phase 0 exit criteria

- CI re-derives every published number; `check-acceptance.ts` runs on every PR.
- No hardcoded repo-specific vocabulary anywhere in the retrieval path.
- Default embedding is a code model; fusion is RRF with an absolute floor.
- Held-out benchmark uses commit-derived ground truth, a BM25 baseline, and reports CIs +
  a symbol-removed ablation gap.
- **Demo:** "here are our numbers on real PRs from 8 public repos, against BM25, with the
  exact-identifier advantage ablated out — and they're reproducible from a clean checkout."

---

## Phase 1 — The proof: grep head-to-head (~8–10 d)

Goal: produce the single launch artifact that answers Anthropic's "agentic grep beat RAG"
position with numbers, in the regime where retrieval is supposed to win.

### WS1.1 — Agentic-grep baseline harness (~4 d)

- Implement a baseline that simulates a coding agent's native search: 3–5 rounds of `ripgrep`
  with query reformulation between rounds (seeded, deterministic), capped at a token budget,
  recording tokens consumed and whether the gold file(s) were surfaced.
- Run it and spacefolding's `retrieve_context` on the same commit-derived tasks across repo
  sizes using the existing corpora: ~1k files (Django), ~10k (Kubernetes/VS Code), ~60k
  (Kibana).
- **Acceptance:** a reproducible script + committed result JSON; both systems measured under
  the same token budget and token estimator.

### WS1.2 — The chart + writeup (~3 d)

- Produce the headline figure: **tokens-to-first-correct-file** and **recall@budget**,
  spacefolding vs grep-only, at 1k / 10k / 60k files. Expect spacefolding to win at scale and
  roughly tie (or honestly lose) on small repos — report both; the honesty is the credibility.
- Draft a launch blog post around it. Lead with the methodology (Phase 0) so the chart is
  believable.
- **Acceptance:** a figure + post a skeptic can reproduce; a clear statement of the repo-size
  crossover where spacefolding starts to pay for itself.

### WS1.3 — Add a local rerank stage (~2 d, if it moves the numbers)

- The `RerankerProvider` interface and `DeterministicRerankerProvider` already exist. Add a
  small local cross-encoder rerank stage after hybrid retrieval (SweRank shows
  retrieve-and-rerank beats expensive agentic localization). Gate inclusion on whether it
  improves Hits@1 on the fixed benchmark.
- **Acceptance:** rerank either improves Hits@1 measurably (ship it) or doesn't (cut it, note
  the negative result — consistent with the project's good habit of publishing negatives).

### Phase 1 exit: a published, reproducible head-to-head showing where spacefolding beats grep.

---

## Phase 2 — Invisible delivery (~12–15 d)

Goal: make it installable in 60 seconds, usable with zero manual tool calls, and robust at
the scale the positioning promises.

### WS2.1 — Distribution (~2 d)

- Publish to npm. Collapse install to `claude mcp add spacefolding -- npx -y spacefolding serve`.
- Auto-download the embedding model on first embed (progress + deterministic fallback); remove
  the separate `download-model` prerequisite step from the happy path.
- Add `spacefolding init` that writes per-project `.mcp.json` and a per-repo DB path (replace
  the global `DB_PATH` + 10k-chunk eviction trap; derive DB from repo root or an XDG cache dir).
- Fix the documented MCP client config (`docs/integration-guide.md:22` says
  `.claude/settings.json`; Claude Code uses `.mcp.json` / `claude mcp add`).
- **Acceptance:** clean-machine script: install → index a repo → first useful retrieval in
  < 60 s, no manual model step.

### WS2.2 — Collapse the tool surface (~2 d)

- Reduce the MCP surface from 12 tools to 2–3 (`retrieve_context`, `ingest`/`status`, optional
  `get_relevant_memory`). Fold `score`/`compress`/`route`/`explain` into internal behavior or
  flags on `retrieve_context`. Make `ingest_context.type` an enum
  (`mcp/server.ts:123-127`); add `readOnlyHint`/`destructiveHint` annotations.
- Make empty-index states self-healing: when chunk count is 0, return a hint
  ("No context ingested — run ingest first") instead of a bare `[]` (`mcp/server.ts:465-509`).
- Add a composite `get_context_for_task` that does ensure-ingested → retrieve → pack in one
  call (the orchestrator already exposes the pieces).
- **Acceptance:** tool-definition token cost measured and reported; an agent with no special
  instructions retrieves successfully on first try against an empty and a populated index.

### WS2.3 — Hooks-driven Claude Code plugin (~4 d)

- Ship a Claude Code plugin bundling: a **SessionStart** hook that auto-indexes the repo (or
  validates freshness) and injects a small context pack; **PreCompact/PostToolUse** hooks that
  re-index changed files and maintain tiering; a thin **Skill** that teaches when to call
  `retrieve_context`. The MCP server becomes the engine, not the interface (this is why
  claude-mem wins on hooks while the official Memory server languishes at #40).
- **Acceptance:** in a real session, context is indexed and injected with zero manual tool
  calls; editing a file updates the index within seconds.

### WS2.4 — Storage scale hardening (~4–5 d) — blockers for the large-repo claim

Pull these from the bug backlog because Phase 1's positioning is "works on big repos":

- **FTS rowid/VACUUM corruption** (`schema.ts:84-85`): migrate `chunks` to an
  `INTEGER PRIMARY KEY` rowid alias + `id TEXT UNIQUE`, point FTS `content_rowid` at it, rebuild
  FTS; or switch to a non-external FTS5 table carrying `chunkId` as an UNINDEXED column. Collapse
  `searchByText`'s two-step `IN(...)` mapping (`repository.ts:684-689`) to a JOIN.
- **vec0 rebuilt every startup** (`vector-index.ts:72-104`): persist the table; only
  DROP/rebuild when dimension actually changed. Maintain count incrementally
  (`this.count += info.changes`) instead of `COUNT(*)` per add/remove — kills the O(n²) ingest.
- **searchByStructure full scans** (`repository.ts:440-552`): push exact phases into SQL using
  the existing `idx_code_symbols_normalized` / `idx_code_references_target` indexes; add an FTS5
  table over symbol names for fuzzy matching, then JS-score only the narrowed candidate set.
- **Batch writes:** `storeChunks`/`storeEmbeddings` wrapped in `db.transaction()`, cached
  prepared statements, `PRAGMA synchronous=NORMAL`, `PRAGMA busy_timeout=5000`.
- **Incremental re-index:** add a Merkle/content-hash file manifest so `ingestProject` skips
  unchanged files entirely (chunk-level dedup exists but FTS still rewrites on every re-ingest —
  `repository.ts:66-92`); freshness/incremental sync is table-stakes credibility now.
- **Acceptance:** index a 60k-file corpus; cold start < a few seconds, re-index of an unchanged
  tree near-zero writes, retrieval latency flat as corpus grows. Memory stays bounded
  (Float32Array storage in `BruteForceVectorIndex`, not boxed `number[]`).

### Phase 2 exit: one-command install, invisible operation, survives 100k chunks.

---

## Phase 3 — Durable moat (ongoing)

- **Public reproducible benchmark/leaderboard:** package the Phase 0 harness so others run it
  against their own retrieval stacks; position spacefolding as the reference implementation for
  "context retrieval for coding agents." This is the moat the project is uniquely positioned to
  own because the suite already exists.
- **Subagent context packs:** first-class "budgeted context pack for this sub-task" output
  optimized for parallel subagents — the token-economics pain felt daily in multi-agent runs.
  Build on `context-pack.ts`; expose token-budget-respecting progressive disclosure (summary
  first, drill-down on request) to align with where MCP is going (Tool Search Tool,
  code-execution-with-MCP).
- **Cross-session memory** (only if Phase 0/1 evidence supports tiering for code): the
  hot/warm/cold tiers could produce the *first* controlled evidence that tiered memory helps
  coding agents (all existing memory benchmarks are conversational) — a genuinely publishable
  differentiator. Treat as a research bet, not a feature claim.

---

## Cross-cutting bug backlog (pull into the phase that first touches the code)

Correctness/operational fixes from the audit, independent of strategy:

- Web server has no `error` listener → `EADDRINUSE` crashes the whole MCP process
  (`web/server.ts:314`). **High.** (Phase 2)
- MCP `ingest_directory`/`ingest_project` accept any absolute path (agent can ingest `~/.ssh`)
  (`mcp/server.ts:538-558`); CLI guard hardcodes `/workspace` (`cli/index.ts:254-261`). Add a
  real ingest-root allowlist. **High.** (Phase 2)
- `score_context` re-embeds the entire corpus on every call (`scorer.ts:32-34`) — reuse stored
  embeddings from `chunk_embeddings`. **High.** (Phase 0, ties into WS0.4)
- Migrations not transactional; `CURRENT_VERSION` not asserted against `max(MIGRATIONS.version)`
  (`repository.ts:33-43`, `current-version.ts:2`) — derive it, wrap each migration in a txn.
  **Medium.** (Phase 2)
- `deleteChunk` / `storeChunk`+invalidation non-atomic (`repository.ts:160-165`, `66-97`);
  `dependencies` table has no FK. **Medium.** (Phase 2)
- Router hot cap is 60% of corpus size (`router.ts:39`) — token-based by default; constraint
  chunks promoted to hot can be silently demoted (`router.ts:67-70`, `151-168`), breaking the
  documented "constraints → hot" guarantee. **Medium.** (Phase 0/1, affects E2E precision)
- Intent detection uses substring matching (`query-planner.ts:61`: "show" contains "how");
  tie-break by key order. Use word-boundary matching. **Low.** (Phase 0)
- Redundancy scoring skips dedup exactly when similarity > 0.95 and penalizes both duplicates
  symmetrically (`scorer.ts:72-80`) — switch to MMR keeping the higher-scoring member.
  **Medium.** (Phase 1)
- `multiHopExpand` ignores seed strength/edge weight/direction and truncates by iteration order
  (`retriever.ts:294-298`); graph is dead by default anyway (`query-planner.ts:261`). Either
  make it a principled, agent-callable multi-hop tool or cut it. **Low/strategic.** (Phase 3)
- LLMLingua default compression rate 0.5 on code (`llmlingua-compression.ts:28`) — restrict
  code to ≤10% or use structural summaries; never compress code chunks in the warm tier.
  **Medium.** (Phase 1)

---

## Product/positioning cleanup (parallel, low-effort, do before any public launch)

- Quarantine internal artifacts from public docs: `ralph.sh`, `docs/PLAN-*`,
  `docs/RESEARCH-PLAN-*`, `docs/PATTERN-*`; rewrite `DESIGN.md` without the "ralph loop" / `/tmp`
  gate framing so it reads as an architecture contract.
- Converge one positioning sentence across `package.json`, `CLAUDE.md`, `docs/index.md`;
  regenerate `CLAUDE.md`'s tool table from the registry (it lists 11, omits `ingest_project`).
- **License (owner's call, flagged not scheduled):** the current source-available license
  defines "commercial" to include internal business use, lists no price, and licenses
  contributions under terms that legally encumber the paid model. Decide: FSL/BUSL-with-
  conversion, PolyForm free tier, or published price + self-serve purchase + a CLA. This blocks
  legal adoption by the stated target audience.

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| After de-contamination, structural no longer beats baselines on real-PR tasks | Medium | High | This is the honest outcome to know *before* launch; if so, reposition around large-repo token economics (Phase 1) where the win is structural, not symbol-lookup |
| Code embedding model too slow/heavy for local-first CPU | Medium | Medium | SFR-Embedding-Code-400M is small; keep transformers.js ONNX path; benchmark CPU latency before defaulting |
| AST chunking depends on a fragile Python sidecar at chunk time | Medium | Medium | Loud fallback to regex + install check; investigate a pure-JS tree-sitter binding to remove the sidecar |
| Storage migration (rowid fix) risks existing DBs | Low | High | Migration writes new schema + rebuilds FTS; ship export/import path and a version check first |
| Grep baseline is too weak/too strong and looks rigged | Medium | High | Open-source the baseline harness; let skeptics tune it; report the crossover honestly |
| Session/token limits stall large benchmark runs (already observed) | High | Low | Shard with workers (exists); checkpoint partial results; run offline, commit artifacts |

## Definition of done (per the original DESIGN.md gate, upgraded)

- `npm run build && npm run lint && npm test` green in CI.
- Acceptance gate passes against **commit-derived** tasks with a **BM25** baseline, reporting
  Hits@1/Hits@5 + bootstrap CIs, *and* the symbol-removed ablation gap is published.
- Published grep-vs-spacefolding head-to-head, reproducible from a clean checkout.
- One-command install; zero-manual-call operation via the plugin; 60k-chunk corpus served
  without startup/scan pathologies.
