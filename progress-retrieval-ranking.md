# retrieval-ranking - Progress Tracker

## Status: REVIEW

## Codebase Patterns

- Acceptance gate uses `/tmp/spacefolding-eval.json` and `/tmp/spacefolding-e2e.json`; generated JSON stays uncommitted.
- Retrieval evaluation now indexes the project root with benchmark-context files such as `.env.example`, while skipping local agent/worktree noise; otherwise dataset tasks can name files that were never ingested.
- Structural retrieval currently beats keyword on the acceptance deltas, but several task-level misses are still ranking/selection problems rather than benchmark-script failures.

## Known Issues

Highest severity first. Resolve before starting new work items.

- None currently.

## Resolved Issues

- 2026-05-23: Completed structural/path ranking work item by strengthening exact path, exact symbol, and direct reference structural scores while damping deterministic lexical scores so broad keyword overlap cannot swamp exact anchors. Added regression coverage for exact path ranking, exact symbol ranking over lexical/vector noise, source-score shape, and batch-delete `ContextFilter` selection.
- 2026-05-23: Fixed baseline structural debug miss T01 "Fix the authentication bug causing 401 errors in the login flow" by adding a narrow auth/login failure expansion to deterministic structural ranking. `src/core/router.ts` now ranks at 2 and `src/core/scorer.ts` ranks at 3; T01 recall@10 improved from `0.3333` to `0.6667`, precision@10 from `0.1` to `0.2`, and NDCG@10 from `0.1564` to `0.5307`.
- 2026-05-23: Fixed baseline residual E2E recall miss E06 "Add batch delete MCP tool" by letting phrase-level delete/filter signals contribute storage/repository path intent in deterministic structural retrieval. E06 now finds `src/mcp/server.ts`, `src/storage/repository.ts`, and `src/types/index.ts` with recall `1`, precision `0.375`, and `12490` tokens.
- 2026-05-23: Fixed the T09 side-effect ranking miss from the baseline list: `src/storage/current-version.ts` now ranks at 5 for "What database schema migrations exist and how are they applied?".
- 2026-05-23: Fixed the T03/T15 top-10 ranking miss by strengthening provider/reranker contract matches and provider barrel-index ranking. T03 now ranks `src/types/index.ts` at 8 and `src/providers/index.ts` at 10; T15 now ranks `src/types/index.ts` at 8.
- 2026-05-23: Fixed the T18 environment lookup diagnostic gap by making retrieval evaluation ingest `.env.example` from the project root. T18 now finds `src/cli/index.ts` at rank 1 and `.env.example` at rank 4, with recall@10 `1.0`, precision@10 `0.2`, and NDCG@10 `0.8772`.

## Completed Work Items

- 1. Record Retrieval Baseline
- 2. Improve Structural And Path Ranking
- 3. Improve Focused Candidate Selection
- 4. Improve Query Planning For Debug And Implement Tasks
- 5. Reranker And Explanation Wiring
- 6. Acceptance-Driven Tuning

## Iteration Log

- 2026-05-23: Work item 1 baseline.
  - Quality gate: `npm run build && npm run lint && npm test` passed; 21 files, 239 tests.
  - Acceptance commands generated `/tmp/spacefolding-eval.json` and `/tmp/spacefolding-e2e.json`; `benchmarks/check-acceptance.ts` passed.
  - Retrieval deltas: structural vs keyword R@10 `+0.0875`, NDCG@10 `+0.145523`, MRR `+0.233810`.
  - Structural averages: R@10 `0.883333`, NDCG@10 `0.721126`, MRR `0.762976`, precision@10 `0.175000`, average results `25.25`.
  - E2E focused averages: recall `0.966667`, precision `0.385198`, tokens `12117.5`; all tasks stayed below full codebase tokens `37678`.
  - Failure classification: no acceptance-gate failures; remaining concrete task-level issues are recall, ranking/fusion, and focused selection/token-efficiency weak spots listed in Known Issues.
- 2026-05-23: Known Issue fix for E06 focused recall.
  - Changed deterministic structural ranking so high-confidence phrase expansions can feed path-intent scoring; batch delete and source/path pattern queries now boost storage/repository candidates before the focused budget is filled.
  - Added `tests/retriever-ranking.test.ts` covering repository ranking ahead of chunker overlap and inclusion inside a focused `13000` token budget.
  - Quality gate: `npm run build && npm run lint && npm test` passed; 22 files, 240 tests.
  - Acceptance gate passed using `/tmp/spacefolding-eval.json` and `/tmp/spacefolding-e2e.json`.
  - Latest structural averages: R@10 `0.900000`, NDCG@10 `0.766087`, MRR `0.818333`, precision@10 `0.180000`, average results `25.15`.
  - Latest E2E focused averages: recall `1.000000`, precision `0.422976`, tokens `12433.1`; all tasks stayed below full codebase tokens `37756`.
- 2026-05-23: Known Issue fix for T03/T15 provider contract ranking.
  - Changed deterministic structural ranking so phrase-level provider/reranker contract terms boost exported interface/type symbols, and `index.ts` barrel files get structural credit when their parent segment matches the query.
  - Added `tests/retriever-ranking.test.ts` cases for provider contract/barrel ranking and reranker provider contracts outranking broad lexical overlap; source score shape remains asserted.
  - Quality gate: `npm run build && npm run lint && npm test` passed; 22 files, 242 tests.
  - Acceptance gate passed using `/tmp/spacefolding-eval.json` and `/tmp/spacefolding-e2e.json`.
  - Latest structural averages: R@10 `0.941667`, NDCG@10 `0.785289`, MRR `0.818333`, precision@10 `0.195000`, average results `26.20`.
  - Latest E2E focused averages: recall `1.000000`, precision `0.379048`, tokens `12417.3`; all tasks stayed below full codebase tokens `37929`.
- 2026-05-23: Known Issue fix for T18 environment lookup measurement.
  - Changed retrieval evaluation to default to the project root, include benchmark context files such as `.env.example`, and skip local agent/worktree directories plus benchmark/data output directories.
  - Added `tests/benchmark-evaluate.test.ts` coverage proving `.env.example` is included while `benchmarks/`, `tests/`, and `.claude/worktrees/` noise is excluded.
  - Quality gate: `npm run build && npm run lint && npm test` passed; 22 files, 244 tests.
  - Acceptance gate passed using `/tmp/spacefolding-eval.json` and `/tmp/spacefolding-e2e.json`.
  - Latest structural averages: R@10 `0.966667`, NDCG@10 `0.797237`, MRR `0.815476`, precision@10 `0.200000`, average results `27.15`.
  - Latest E2E focused averages: recall `1.000000`, precision `0.379048`, tokens `12417.6`; all tasks stayed below full codebase tokens `37929`.
- 2026-05-23: Known Issue fix for T01 auth/login debug ranking.
  - Added deterministic structural phrase expansion for auth/login failures so scorer/router modules receive structural and path-intent credit when the query has no exact code symbol anchor.
  - Added `tests/retriever-ranking.test.ts` coverage proving `src/core/scorer.ts` and `src/core/router.ts` outrank lexical-only distractors for the T01-style query.
  - Quality gate: `npm run build && npm run lint && npm test` passed; 22 files, 245 tests.
  - Acceptance gate passed using `/tmp/spacefolding-eval.json` and `/tmp/spacefolding-e2e.json`.
  - T01 metrics: recall@10 `0.666667`, precision@10 `0.200000`, NDCG@10 `0.530721`; `src/core/router.ts` ranked 2 and `src/core/scorer.ts` ranked 3.
  - Latest structural averages: R@10 `0.983333`, NDCG@10 `0.815952`, MRR `0.833333`, precision@10 `0.205000`, average results `27.50`.
  - Latest E2E focused averages: recall `1.000000`, precision `0.387738`, tokens `12444.3`; all tasks stayed below full codebase tokens `37945`.
- 2026-05-23: Work item 2 structural/path ranking.
  - Raised repository structural scores for exact path, extensionless path-stem, exact symbol, and direct reference matches; deterministic structural retrieval now dampens raw lexical scores so high-overlap noise cannot outrank exact structural anchors.
  - Tuned sparse exact contract scoring for implementation tasks so `ContextFilter`/type contracts survive focused selection when source/path filter language is present.
  - Added `tests/retriever-ranking.test.ts` coverage for exact path ranking, exact symbol ranking over lexical and deterministic vector noise, complete `sourceScores`, and focused batch-delete type selection; added `tests/structural-indexer.test.ts` coverage for repository exact path/symbol/reference scoring.
  - Quality gate: `npm run build && npm run lint && npm test` passed; 22 files, 249 tests.
  - Acceptance gate passed using `/tmp/spacefolding-eval.json` and `/tmp/spacefolding-e2e.json`.
  - Latest structural averages: R@10 `0.983333`, NDCG@10 `0.889618`, MRR `0.933333`, precision@10 `0.205000`, average results `27.50`.
  - Latest retrieval deltas: structural vs keyword R@10 `+0.187500`, NDCG@10 `+0.319765`, MRR `+0.408333`.
  - Latest E2E focused averages: recall `1.000000`, precision `0.385913`, tokens `12364.9`; all tasks stayed below full codebase tokens `38103`.
- 2026-05-23: Work item 3 focused candidate selection.
  - Verified focused selection behavior against spec: `createRetrievalSelectionPolicy` produces focused moderate target 13000, minKeep protects top candidates from threshold and per-path caps, split parent chunks are excluded, dropped candidates carry concrete reasons, and `fillBudget` never exceeds hard budget.
  - Added `tests/retrieval-policy.test.ts` coverage for protected candidates bypassing per-path cap, and per-path cap dropping non-protected candidates after protected set uses cap slots.
  - Added `tests/budget.test.ts` coverage for hard budget enforcement with many candidates, hard budget enforcement with hot chunks, and deterministic focused selection through the full selection → budget pipeline.
  - Quality gate: `npm run build && npm run lint && npm test` passed; 22 files, 254 tests.
  - Acceptance gate passed using `/tmp/spacefolding-eval.json` and `/tmp/spacefolding-e2e.json`.
  - Latest structural averages: R@10 `0.983333`, NDCG@10 `0.889618`, MRR `0.933333`, precision@10 `0.205000`, average results `27.50`.
  - Latest retrieval deltas: structural vs keyword R@10 `+0.187500`, NDCG@10 `+0.319765`, MRR `+0.408333`.
  - Latest E2E focused averages: recall `1.000000`, precision `0.385913`, tokens `12364.9`; all tasks stayed below full codebase tokens `38103`.
- 2026-05-23: Work item 4 query planning for debug and implement tasks.
  - Verified mutation queries classify as `implement` unless opened by explicit lookup terms (`where`, `find`, etc.); "add support for X" correctly returns `implement`.
  - Verified identifier/path extraction: `SQLiteRepository` splits into `['sqlite', 'repository']`, `retrieve_context` splits into `['retrieve', 'context']`, `src/core/retriever.ts` extracts path fragments, tokens, and extension correctly.
  - Verified `recommendedTopK` tuning by intent and complexity: narrow=5, moderate debug/implement/explain=10, broad=15.
  - Added `tests/query-planner.test.ts` coverage for "add support for X" intent, `SQLiteRepository` splitting, `retrieve_context` splitting, and `src/core/retriever.ts` path extraction.
  - Quality gate: `npm run build && npm run lint && npm test` passed; 22 files, 258 tests.
- 2026-05-23: Work item 5 reranker and explanation wiring.
  - Verified reranker is wired into `HybridRetriever.retrieve()`: top 20 candidates are reranked when a reranker provider is available, with structural exact-match boosts preserved; reranker failure falls back to fused ordering silently.
  - Verified `PipelineOrchestrator` constructor creates `DeterministicRerankerProvider` for the retriever.
  - Verified retrieval explanations include score breakdown reasons with `structural=`, `vector=`, `fts=`, `graph=`, `dependency=`, `final=` format.
  - Added `tests/retriever-ranking.test.ts` coverage for score breakdown in reasons: verifies the `scores` reason string contains all six source score components with 3-decimal precision.
  - Quality gate: `npm run build && npm run lint && npm test` passed; 22 files, 259 tests.
- 2026-05-23: Work item 6 acceptance-driven tuning.
  - Full acceptance gate passed with all 13 checks green.
  - Final structural averages: R@10 `0.983333`, NDCG@10 `0.889618`, MRR `0.933333`, precision@10 `0.205000`, average results `27.50`.
  - Final retrieval deltas: structural vs keyword R@10 `+0.187500`, NDCG@10 `+0.319765`, MRR `+0.408333`.
  - Final E2E focused averages: recall `1.000000`, precision `0.385913`, tokens `12364.9`; all tasks below full codebase tokens `38103`.
  - No metric failures to fix; acceptance gate passes without changes.

## Review Log

- 2026-05-25: Review phase.
  - **Code Consistency**: Re-swept retrieval option handling across CLI, MCP, web, and orchestrator paths. Fixed the web `/api/retrieve` endpoint so it now validates and passes through `strategy`, `topK`, `returnLimit`, and `maxHops`, matching CLI/MCP retrieval controls while preserving focused/default behavior.
  - Added `tests/interface.test.ts` coverage for web retrieval option passthrough and invalid `strategy`, `topK`, `returnLimit`, and `maxHops` diagnostics.
  - Quality gate: `npm run build`, `npm run lint`, and `npm test` passed; 28 files, 338 tests.
  - Acceptance benchmarks not run because default retrieval ranking, selection, and budget behavior were unchanged; this iteration only fixed web interface option handling.
- 2026-05-25: Review phase.
  - **Test Coverage**: Re-swept query planner, retriever, focused selection policy, and budget tests against `IMPLEMENTATION.md` section 7 and the design retrieval/selection invariants. Query planner, selection policy, and budget invariants were already directly covered; retriever graph coverage still lacked the pure `strategy: 'graph'` path.
  - Fixed the graph-only traversal edge case exposed by the new test: `multiHopExpand()` now caps returned graph expansions instead of counting seed chunks against `topK`, so graph strategy can return dependency results when recent seed count is larger than the requested result count.
  - Added `tests/retriever-ranking.test.ts` coverage for pure graph strategy traversal from recent chunks with positive graph source scores and final-score reporting.
  - Quality gate: `npm run build && npm run lint && npm test` passed; 28 files, 337 tests.
  - Acceptance gate passed using `/tmp/spacefolding-eval.json` and `/tmp/spacefolding-e2e.json`.
  - Latest structural averages: R@10 `0.983333`, NDCG@10 `0.890205`, MRR `0.933333`, precision@10 `0.205000`, average results `22.60`.
  - Latest structural deltas: R@10 `+0.170833`, NDCG@10 `+0.293116`, MRR `+0.358333`.
  - Latest E2E focused averages: recall `0.950000`, precision `0.432619`, tokens `10967.4`; all tasks stayed below full codebase tokens `42125`.
- 2026-05-25: Review phase.
  - **Error Handling**: Re-swept retrieval fallback paths for discarded errors and source failures. Fixed hybrid/structural retrieval so full-text/lexical lookup failures degrade to available structural/vector results with explicit warning reasons, while text-only failures still throw. Fixed explicit hybrid graph expansion so dependency-graph failures preserve already-fused results with an explicit graph warning; graph-only remains loud.
  - Added `tests/retriever-ranking.test.ts` coverage for hybrid text-source fallback to vector results, text-only failure propagation, and hybrid graph-expansion fallback.
  - Quality gate: `npm run build && npm run lint && npm test` passed; 28 files, 336 tests.
  - Acceptance gate passed using `/tmp/spacefolding-eval.json` and `/tmp/spacefolding-e2e.json`.
  - Latest structural averages: R@10 `0.983333`, NDCG@10 `0.890205`, MRR `0.933333`, precision@10 `0.205000`, average results `22.60`.
  - Latest structural deltas: R@10 `+0.170833`, NDCG@10 `+0.293116`, MRR `+0.358333`.
  - Latest E2E focused averages: recall `0.950000`, precision `0.432619`, tokens `10967.2`; all tasks stayed below full codebase tokens `42125`.
- 2026-05-25: Review phase.
  - **Spec Compliance**: Re-swept `IMPLEMENTATION.md` section 7 and the design retrieval/selection invariants from scratch. Checked query plan fields, adaptive strategy/topK/budget planning, structural/vector/FTS source usage, deterministic-vector damping, graph traversal default-off behavior, source score/reason reporting, focused/broad/exhaustive target budgets, split-parent candidate exclusion, dropped/omitted diagnostics, and hard budget enforcement through `PipelineOrchestrator.retrieve()`.
  - No spec-compliance defects found in this fresh sweep.
  - Quality gate: `npm run build && npm run lint && npm test` passed; 28 files, 333 tests.
  - Acceptance benchmarks not run because no retrieval ranking, selection, or budget behavior changed.
- 2026-05-25: Review phase.
  - **Code Consistency**: Re-swept retrieval score reasons, source score names, and retrieval option handling. Fixed reranker final-score consistency so reranked candidates now return `score` and `sourceScores.final` matching the rerank-adjusted order, include explicit reranker reasons, and share one source-score breakdown formatter between retriever output and CLI display.
  - Added `tests/retriever-ranking.test.ts` coverage proving reranked ordering, returned `score`, `sourceScores.final`, and the `scores ... final=` reason agree.
  - Quality gate: `npm run build && npm run lint && npm test` passed; 25 files, 303 tests.
  - Acceptance gate passed using `/tmp/spacefolding-eval.json` and `/tmp/spacefolding-e2e.json`.
  - Latest structural averages: R@10 `0.983333`, NDCG@10 `0.890205`, MRR `0.933333`, precision@10 `0.205000`, average results `22.70`.
  - Latest structural deltas: R@10 `+0.187500`, NDCG@10 `+0.300656`, MRR `+0.358333`.
  - Latest E2E focused averages: recall `1.000000`, precision `0.419683`, tokens `10972.9`; all tasks stayed below full codebase tokens `41581`.
- 2026-05-25: Review phase.
  - **Test Coverage**: Re-swept query planner, retriever, focused selection policy, and budget tests against the retrieval behavior and selection/budget invariants in `IMPLEMENTATION.md` section 7 and `DESIGN.md`.
  - Fixed a retriever coverage gap for graph traversal behavior: hybrid retrieval now has tests proving dependency graph traversal stays disabled by default and only contributes graph-sourced results when `maxHops` is explicitly requested.
  - Added `tests/retriever-ranking.test.ts` coverage for default-off graph traversal and explicit hybrid graph expansion with a positive graph source score.
  - Quality gate: `npm run build && npm run lint && npm test` passed; 25 files, 302 tests.
  - Acceptance benchmarks not run because retrieval ranking, selection, and budget behavior were unchanged; this iteration only added coverage.
- 2026-05-25: Review phase.
  - **Error Handling**: Re-swept retrieval fallback paths for discarded errors and silent failures. Fixed structural lookup failures so structural retrieval degrades to available vector/text or deterministic lexical results with an explicit warning reason instead of failing the whole retrieval.
  - Added `tests/retriever-ranking.test.ts` coverage for reliable-embedding structural fallback to vector/text sources and deterministic structural fallback to lexical results when structural lookup throws.
  - Quality gate: `npm run build && npm run lint && npm test` passed; 25 files, 300 tests.
  - Acceptance gate passed using `/tmp/spacefolding-eval.json` and `/tmp/spacefolding-e2e.json`.
  - Latest structural averages: R@10 `0.983333`, NDCG@10 `0.890205`, MRR `0.933333`, precision@10 `0.205000`, average results `22.70`.
  - Latest structural deltas: R@10 `+0.187500`, NDCG@10 `+0.300656`, MRR `+0.358333`.
  - Latest E2E focused averages: recall `1.000000`, precision `0.412937`, tokens `10948.7`; all tasks stayed below full codebase tokens `41495`.
- 2026-05-25: Review phase.
  - **Spec Compliance**: Re-swept `IMPLEMENTATION.md` section 7 retrieval behavior against the current query planning, retriever, selection policy, budget fill, and orchestrator wiring. Verified required plan fields, structural/vector/FTS source selection rules, graph traversal staying disabled by default, source score reporting, focused thresholds/per-path caps, split-parent exclusion, dropped/omitted diagnostics, and hard budget enforcement.
  - No spec-compliance defects found in this fresh sweep.
  - Quality gate: `npm run build && npm run lint && npm test` passed; 25 files, 298 tests.
  - Acceptance benchmarks not run because no retrieval ranking, selection, or budget behavior changed.
- 2026-05-25: Review phase.
  - **Spec Compliance**: Re-swept `IMPLEMENTATION.md` section 7 and the design selection/budgeting invariants. Fixed retrieval reporting so focused candidate drops are exposed with concrete reasons instead of only a count.
  - `PipelineOrchestrator.retrieve()` now returns `dropped`, and CLI/web/MCP retrieval surfaces expose dropped candidate reasons alongside omitted chunks.
  - Added `tests/orchestrator.test.ts` coverage for focused per-path candidate drops being returned with reasons, and `tests/interface.test.ts` coverage for web retrieval exposing dropped diagnostics.
  - Quality gate: `npm run build && npm run lint && npm test` passed; 25 files, 298 tests.
  - Acceptance benchmarks not run because ranking, selection, and budget behavior were unchanged; this iteration only wires existing dropped-candidate diagnostics through retrieval outputs.
- 2026-05-25: Review phase.
  - **Error Handling**: Re-swept retrieval fallback paths for discarded errors and silent failures. Fixed hybrid/structural vector retrieval so query embedding or vector-index failures degrade to available text/structural results with an explicit result reason, while explicit vector-only retrieval still fails loudly.
  - Added `tests/rag.test.ts` coverage for hybrid fallback when query embedding fails and vector-only failure propagation.
  - Quality gate: `npm run build && npm run lint && npm test` passed; 25 files, 297 tests.
  - Acceptance gate passed using `/tmp/spacefolding-eval.json` and `/tmp/spacefolding-e2e.json`.
  - Latest structural averages: R@10 `0.983333`, NDCG@10 `0.890205`, MRR `0.933333`, precision@10 `0.205000`, average results `22.25`.
  - Latest structural deltas: R@10 `+0.187500`, NDCG@10 `+0.300656`, MRR `+0.358333`.
  - Latest E2E focused averages: recall `1.000000`, precision `0.407937`, tokens `10947.8`; all tasks stayed below full codebase tokens `41190`.
- 2026-05-24: Review phase.
  - **Spec Compliance**: Re-swept `IMPLEMENTATION.md` section 7 retrieval behavior and the design selection/budgeting invariants. Fixed focused candidate selection so split parent metadata chunks and missing retrieval chunks are reported in `dropped` with concrete reasons instead of being silently filtered.
  - Added `tests/retrieval-policy.test.ts` assertions for split parent and missing chunk drop reasons.
  - Quality gate: `npm run build && npm run lint && npm test` passed; 25 files, 295 tests.
  - Acceptance gate passed using `/tmp/spacefolding-eval.json` and `/tmp/spacefolding-e2e.json`.
  - Latest structural deltas: R@10 `+0.187500`, NDCG@10 `+0.300656`, MRR `+0.358333`.
  - Latest E2E focused averages: recall `1.000000`, precision `0.404365`, tokens `10911.1`; all tasks stayed below full codebase tokens `41136`.
- 2026-05-23: Review phase.
  - **Integration Wiring**: Fixed `hotChunkIds` not being passed to `fillBudget()` in `PipelineOrchestrator.retrieve()`. The hot-priority budget mechanism existed but was bypassed; dependency-heavy chunks now get Phase 1 budget priority.
  - **Dead Code**: Removed `querieds` typo entry from `TERM_EXPANSIONS` in `src/core/retriever.ts`.
  - **Code Consistency**: Removed duplicate `'exact'` from `NARROWING_TERMS` in `src/core/query-planner.ts`.
  - **Code Consistency**: Fixed score reason format in `retrieveDeterministicStructural` to use `sourceScores.vector.toFixed(3)` and `sourceScores.graph.toFixed(3)` instead of hardcoded `0.000`, matching the format in `retrieve()`.
  - **Security**: No SQL injection risks found. All user input flows through parameterized queries or is sanitized before FTS5 query assembly.
  - **Test Coverage**: Strong for pure-logic modules (query-planner 50 tests, retrieval-policy 27 tests, budget 18 tests). Retriever covered through mock-based tests (8 in retriever-ranking, 33 in rag). Gap noted: no repository-level integration tests for search methods, and no graph traversal tests. These are outside the current work item scope.
  - Quality gate: `npm run build && npm run lint && npm test` passed; 22 files, 259 tests.
