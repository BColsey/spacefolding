# retrieval-ranking - Autonomous Agent Instructions

## Housekeeping

Ignore:

- `ralph-retrieval-ranking.log`
- `coverage/`
- `benchmarks/*.db`
- `benchmarks/*.db-wal`
- `benchmarks/*.db-shm`
- `/tmp/spacefolding-*.json`

Pre-existing uncommitted changes are not your problem. Only commit files you changed.

## Prime Directive

You are improving Spacefolding retrieval ranking and focused token efficiency. This loop should move the acceptance gate toward passing by changing query planning, fusion, reranking, candidate selection, and budget behavior.

This loop depends on the measurement loop being good enough to show actual failures. If benchmark diagnostics are missing, add a Known Issue to `progress-retrieval-ranking.md` and make the smallest measurement fix needed.

## Authority Hierarchy

1. `DESIGN.md`
2. `IMPLEMENTATION.md`
3. This prompt

## Rules of Engagement

Non-negotiable:

1. Read `progress-retrieval-ranking.md` first.
2. One work item per iteration.
3. Every retrieval change must have tests proving ranking, selection, or budget behavior.
4. Focused mode must return compact context and never exceed hard budget.
5. Graph traversal stays disabled by default unless a test proves it helps a specific mode.

Prohibited:

- No lowering benchmark thresholds.
- No returning the whole codebase in focused mode.
- No rank-only fusion if raw source scores are available.
- No ignored reranker failures except the existing best-effort fallback with test coverage.
- No implemented-but-unwired retrieval components.
- No writing "Loop Complete" or "Loop Done" in the progress file.

## Environment

- Working directory: `/home/ben/Documents/Projects/spacefolding`
- Language: TypeScript ESM on Node
- Test framework: Vitest
- Progress file: `progress-retrieval-ranking.md`

## Quality Gate

Run after every code change:

```bash
npm run build && npm run lint && npm test
```

Run acceptance benchmarks when a work item affects retrieval behavior:

```bash
npm run build
npx tsx benchmarks/evaluate.ts --strategy all --json > /tmp/spacefolding-eval.json
npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json > /tmp/spacefolding-e2e.json
npx tsx benchmarks/check-acceptance.ts \
  --retrieval-json /tmp/spacefolding-eval.json \
  --e2e-json /tmp/spacefolding-e2e.json
```

## Workflow Per Iteration

1. Read `progress-retrieval-ranking.md`.
2. Fix Known Issues first.
3. Otherwise choose the lowest-numbered incomplete work item.
4. Read referenced spec sections.
5. Implement and test.
6. Run quality gate.
7. Run benchmark commands when relevant.
8. Commit only your changes.
9. Update `progress-retrieval-ranking.md`.

## Work Items

### 1. Record Retrieval Baseline

Spec sections: `DESIGN.md` "Success Metrics", `IMPLEMENTATION.md` sections 7 and 10.
Files: `progress-retrieval-ranking.md`; benchmark scripts only if diagnostics are missing.

Deliver:

- Run retrieval and E2E benchmark commands.
- Record failing metrics and top missed tasks in Known Issues.
- Identify whether failures are recall, precision, ranking, or token-budget problems.

Tests:

- Run `npm run build && npm run lint && npm test`.
- Run both benchmark JSON commands.
- Run checker and record exact failures.

Done when: Known Issues names concrete retrieval failures to fix.

### 2. Improve Structural And Path Ranking

Spec sections: `DESIGN.md` "Retrieval Design", `IMPLEMENTATION.md` sections 6 and 7.
Files: `src/core/retriever.ts`, `src/core/query-planner.ts`, `src/storage/repository.ts`, `tests/rag.test.ts`, `tests/query-planner.test.ts`, `tests/scorer.test.ts` as needed.

Deliver:

- Improve exact path, filename, symbol, and reference boosts for code-search and implementation tasks.
- Preserve deterministic embedding behavior without vector noise dominating lexical/structural signals.
- Keep `RetrievalResult.sourceScores` accurate.

Tests:

- Exact path query ranks matching path first.
- Symbol exact match outranks broad lexical overlap.
- Deterministic embeddings do not cause unrelated vector results to outrank exact structural matches.
- Source scores include structural, vector, fts, dependency, graph, and final.

Done when: structural retrieval ranking improves without breaking existing retrieval tests.

### 3. Improve Focused Candidate Selection

Spec sections: `DESIGN.md` "Selection And Budgeting", `IMPLEMENTATION.md` section 7.
Files: `src/core/retrieval-policy.ts`, `src/core/budget.ts`, `tests/retrieval-policy.test.ts`, `tests/budget.test.ts`.

Deliver:

- Focused mode should target `<= 13000` average tokens for moderate tasks.
- Preserve top candidates, then apply score threshold and per-path cap.
- Report dropped candidates with reason.
- Never include parent metadata split chunks.

Tests:

- Focused moderate policy target is 13000 or less.
- Candidates below threshold are dropped after protected set.
- Per-path cap drops extra chunks after protected set.
- Split parent chunks are excluded.
- Hard budget cannot be exceeded.

Done when: focused selection is compact and deterministic.

### 4. Improve Query Planning For Debug And Implement Tasks

Spec sections: `DESIGN.md` "Query Planning", `IMPLEMENTATION.md` section 7.
Files: `src/core/query-planner.ts`, `src/core/retriever.ts`, `tests/query-planner.test.ts`, `tests/rag.test.ts`.

Deliver:

- Ensure mutation queries classify as `implement` unless they are explicit lookup queries.
- Improve identifier/path extraction for names like `retrieve_context`, `SQLiteRepository`, and `src/core/retriever.ts`.
- Tune `recommendedTopK` by intent and complexity without making focused output too large.

Tests:

- "add support for X" classifies as `implement`.
- "where is X defined" classifies as `code_search`.
- Path fragments and extensions are extracted from explicit paths.
- CamelCase and snake_case identifiers are split into useful parts.

Done when: query plans produce better structural inputs for known benchmark misses.

### 5. Reranker And Explanation Wiring

Spec sections: `DESIGN.md` "Retrieval Design", `IMPLEMENTATION.md` sections 6 and 7.
Files: `src/core/retriever.ts`, `src/providers/deterministic-reranker.ts`, `src/pipeline/orchestrator.ts`, `tests/rag.test.ts`, `tests/orchestrator.test.ts`.

Deliver:

- Reranker must affect ordering for top candidates when available.
- Reranker failure remains best-effort and falls back to fused ordering.
- Retrieval explanations must show useful reasons and final source scores.

Tests:

- Mock or deterministic reranker changes ordering when scores differ.
- Reranker throw keeps retrieval successful.
- Returned reasons include score breakdown.

Done when: reranking is wired, tested, and observable.

### 6. Acceptance-Driven Tuning

Spec sections: `DESIGN.md` "Success Metrics", `IMPLEMENTATION.md` section 10.
Files: retrieval files and tests touched by actual failures.

Deliver:

- Run the full acceptance gate.
- Fix concrete failing metrics until the checker passes, or document a technical blocker with exact metric values in Known Issues.
- Do not change thresholds.

Tests:

- `npm run build && npm run lint && npm test`
- Full acceptance command from the quality gate.

Done when: acceptance passes, or Known Issues contains the smallest remaining blockers with exact task and metric evidence.

## Review Phase

When all work items are done, enter review. You NEVER write "Loop Complete" or "Loop Done" in `progress-retrieval-ranking.md`.

Review mode is cyclic and indefinite. The fact that every category already has
an entry is not a stopping condition and is not a reason for a no-op iteration.
The human stops the loop.

At the start of every review iteration:

1. Read Known Issues. If any are present, fix all Known Issues first, highest
   severity first, then run the quality gate and commit the fixes.
2. If Known Issues is empty, choose exactly one review category for a full
   sweep. Use the categories in order below. If all categories already have
   entries in Review Log, cycle back to category 1 and continue with a fresh
   sweep.
3. Re-evaluate the chosen category from scratch. Do not say "already reviewed",
   "no work left", or "same as prior cycle".
4. If you find defects, fix them in the same iteration.
5. If a complete fresh sweep finds no defects, still run
   `npm run build && npm run lint && npm test`, add a Review Log entry naming
   the exact category and what was checked, and commit the progress-file update.

Review categories:

1. Spec Compliance: retrieval behavior vs `IMPLEMENTATION.md` section 7.
2. Error Handling: discarded errors and silent fallback paths.
3. Test Coverage: query planner, retriever, selection policy, budget.
4. Code Consistency: scoring reasons, source score names, option handling.
5. Dead Code: unused fusion helpers, unused expansion code, unwired rerankers.
6. Integration Wiring: `PipelineOrchestrator.retrieve()` uses every implemented retrieval component.
7. Security And Data Integrity: no unsafe SQL query assembly beyond parameterized FTS input.

Known Issues always come first. If you find a defect, fix it.

## Reminders

- Focused retrieval is supposed to be small.
- Ranking quality matters as much as recall.
- Do not make graph traversal default.
- Do not lower thresholds.
- Never write "Loop Complete" in the progress file.
