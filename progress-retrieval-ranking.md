# retrieval-ranking - Progress Tracker

## Status: IN PROGRESS

## Codebase Patterns

- Acceptance gate uses `/tmp/spacefolding-eval.json` and `/tmp/spacefolding-e2e.json`; generated JSON stays uncommitted.
- Structural retrieval currently beats keyword on the acceptance deltas, but several task-level misses are still ranking/selection problems rather than benchmark-script failures.

## Known Issues

Highest severity first. Resolve before starting new work items.

1. Baseline structural ranking misses top-10 relevant files even though they are retrieved later: T03 ranks `src/providers/index.ts` at 12 and `src/types/index.ts` at 14; T15 ranks `src/types/index.ts` at 11. These are ranking/fusion problems.
2. Baseline structural environment lookup miss: T18 "What environment variables control the system behavior?" misses `.env.example` and only ranks `src/cli/index.ts` at 7, producing recall@10 `0.5`, precision@10 `0.1`, and MRR `0.1429`. This is a path/lexical recall and ranking problem for config-file queries.
3. Baseline structural debug miss: T01 "Fix the authentication bug causing 401 errors in the login flow" misses `src/core/scorer.ts` and `src/core/router.ts`, producing recall@10 `0.3333`, precision@10 `0.1`, and NDCG@10 `0.1815`. This is a query-planning/ranking problem for debug tasks.

## Resolved Issues

- 2026-05-23: Fixed baseline residual E2E recall miss E06 "Add batch delete MCP tool" by letting phrase-level delete/filter signals contribute storage/repository path intent in deterministic structural retrieval. E06 now finds `src/mcp/server.ts`, `src/storage/repository.ts`, and `src/types/index.ts` with recall `1`, precision `0.375`, and `12490` tokens.
- 2026-05-23: Fixed the T09 side-effect ranking miss from the baseline list: `src/storage/current-version.ts` now ranks at 5 for "What database schema migrations exist and how are they applied?".

## Completed Work Items

- 1. Record Retrieval Baseline

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

## Review Log

(Entries added during review phase: category reviewed, what was checked, what was fixed.)
