# measurement - Autonomous Agent Instructions

## Housekeeping

Ignore these files and artifacts:

- `ralph-measurement.log`
- `coverage/`
- `benchmarks/*.db`
- `benchmarks/*.db-wal`
- `benchmarks/*.db-shm`
- `/tmp/spacefolding-*.json`

Pre-existing uncommitted changes are not your problem. Only commit files you changed.

## Prime Directive

You are building the measurement loop for Spacefolding. This loop makes benchmarks, acceptance checks, and diagnostic reports trustworthy enough to guide retrieval work.

This loop has no dependency on other loops. Do not tune retrieval ranking unless a benchmark bug requires it.

## Authority Hierarchy

1. `DESIGN.md`: product behavior and acceptance goals.
2. `IMPLEMENTATION.md`: contracts, file ownership, and quality gates.
3. This prompt: measurement work items and workflow.

## Rules of Engagement

Non-negotiable:

1. Read `progress-measurement.md` first on every iteration.
2. Do one work item per iteration.
3. Generated benchmark JSON belongs in `/tmp`, not the repo.
4. Benchmark output must be deterministic for a fixed dataset and corpus.
5. Acceptance failures must be actionable: show the metric, actual value, and expected condition.

Prohibited:

- No modifying retrieval scoring to make a benchmark pass.
- No committing private held-out datasets.
- No skipped or empty tests.
- No changing acceptance thresholds without updating `DESIGN.md`, `IMPLEMENTATION.md`, and `benchmarks/ACCEPTANCE.md` in the same commit.
- No ignoring malformed JSON or missing strategy summaries.
- No writing "Loop Complete" or "Loop Done" in the progress file.

## Environment

- Working directory: `/home/ben/Documents/Projects/spacefolding`
- Language: TypeScript ESM on Node
- Test framework: Vitest
- Specs: `DESIGN.md`, `IMPLEMENTATION.md`
- Progress file: `progress-measurement.md`

## Quality Gate

Run this after every code change and before committing:

```bash
npm run build && npm run lint && npm test
```

Benchmark commands may be slow. Run them when a work item changes benchmark or acceptance behavior:

```bash
npm run build
npx tsx benchmarks/evaluate.ts --strategy all --json > /tmp/spacefolding-eval.json
npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json > /tmp/spacefolding-e2e.json
npx tsx benchmarks/check-acceptance.ts \
  --retrieval-json /tmp/spacefolding-eval.json \
  --e2e-json /tmp/spacefolding-e2e.json
```

If the benchmark acceptance gate fails before retrieval-ranking work is finished, record the exact failures in `progress-measurement.md` Known Issues. Do not lower thresholds.

## Workflow Per Iteration

1. Read `progress-measurement.md`.
2. Pick the lowest-numbered incomplete work item.
3. Read the referenced sections in `DESIGN.md` and `IMPLEMENTATION.md`.
4. Implement the item.
5. Add or update tests.
6. Run the quality gate.
7. Commit only your changes.
8. Update `progress-measurement.md` with completed item, iteration log, and discovered patterns.

## Work Items

### 1. Baseline Measurement Runbook

Spec sections: `DESIGN.md` "Success Metrics", `IMPLEMENTATION.md` sections 10 and 11.
Files: `benchmarks/ACCEPTANCE.md`, `benchmarks/HELDOUT.md`, `README.md` if needed.

Deliver:

- Ensure docs show the exact retrieval, E2E, and checker commands.
- Document that generated JSON goes to `/tmp`.
- Document the one-hour ralph pacing command with `RALPH_SLEEP_SECONDS=3600`.

Tests:

- Run `npm run build && npm run lint && npm test`.
- Manually verify every documented command has a concrete output path.
- Verify no generated JSON is added to git status.

Done when: a new agent can run the benchmark suite from docs without guessing.

### 2. Retrieval Benchmark Diagnostics

Spec sections: `DESIGN.md` "Benchmark Design", `IMPLEMENTATION.md` section 10.
Files: `benchmarks/evaluate.ts`, `tests/*benchmark*` if adding tests is appropriate.

Deliver:

- Ensure JSON includes per-strategy averages and per-task hit/miss details.
- Ensure `successGate.structuralBeatsKeyword` is present when keyword and structural summaries exist.
- Ensure missing strategy summaries are obvious to the checker.

Tests:

- Unit or integration test JSON shape if an existing pattern exists.
- Run `npm run build && npm run lint && npm test`.
- Run `npx tsx benchmarks/evaluate.ts --strategy all --json > /tmp/spacefolding-eval.json` and inspect JSON keys.

Done when: retrieval benchmark output explains why structural failed or passed.

### 3. E2E Benchmark Diagnostics

Spec sections: `DESIGN.md` "Benchmark Design", `IMPLEMENTATION.md` section 10.
Files: `benchmarks/e2e-benchmark.ts`, `benchmarks/check-acceptance.ts`, tests.

Deliver:

- Ensure JSON summary includes average recall, precision, tokens, codebase tokens, and current-vs-structural deltas.
- Ensure tasks returning more tokens than the codebase are listed.
- Ensure focused retrieval pass/fail is represented in `successGate.focusedRetrievalPasses`.

Tests:

- Run `npm run build && npm run lint && npm test`.
- Run `npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json > /tmp/spacefolding-e2e.json`.
- Verify `benchmarks/check-acceptance.ts --e2e-json /tmp/spacefolding-e2e.json` reports exact failing metrics if any.

Done when: E2E JSON is sufficient for the checker and for manual diagnosis.

### 4. Held-Out Benchmark Safety

Spec sections: `DESIGN.md` "Benchmark Design", `IMPLEMENTATION.md` section 10.
Files: `benchmarks/generate-heldout.ts`, `benchmarks/profile-retrieval.ts`, `benchmarks/HELDOUT.md`, `.gitignore` if needed.

Deliver:

- Ensure generated held-out datasets are documented as `/tmp` artifacts.
- Ensure docs warn not to commit private corpora or generated task JSON.
- Ensure profiler output is documented enough to compare ingest cost, latency, returned tokens, and memory.

Tests:

- Run `npm run build && npm run lint && npm test`.
- If a public local corpus is available, generate a tiny held-out dataset with `--limit 5` under `/tmp`.
- Verify no generated held-out files appear as tracked changes.

Done when: held-out evaluation is reproducible without leaking local/private data.

### 5. Acceptance Checker Clarity

Spec sections: `DESIGN.md` "Success Metrics", `IMPLEMENTATION.md` section 10.
Files: `benchmarks/check-acceptance.ts`, `benchmarks/ACCEPTANCE.md`, tests.

Deliver:

- Checker output must list each check as pass/fail with actual and expected values.
- Missing JSON sections must fail with a direct message.
- `--json` output must include a top-level `passed` boolean and `checks` array.

Tests:

- Run `npm run build && npm run lint && npm test`.
- Run checker with retrieval JSON only, E2E JSON only, and both.
- Run checker against malformed or incomplete temporary JSON and verify nonzero exit.

Done when: acceptance failure tells the next loop exactly what to fix.

## Review Phase

When all work items are complete, enter review. You NEVER write "Loop Complete" or "Loop Done" in `progress-measurement.md`. The human decides when to stop ralph.

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

Review categories, cycle one per iteration:

1. Spec Compliance: compare benchmark behavior to `DESIGN.md` and `IMPLEMENTATION.md`.
2. Error Handling: malformed JSON, missing files, missing summaries, and process failures.
3. Test Coverage: benchmark helper functions and checker branches.
4. Code Consistency: CLI arg parsing and JSON shape across benchmark scripts.
5. Dead Code: unused benchmark fields, stale docs, unwired checker branches.
6. Integration Wiring: docs commands match real scripts and package scripts.
7. Security And Data Integrity: no private datasets or generated DB files committed.

Known Issues always come first. If you find a defect, fix it in the same iteration.

## Reminders

- Do not weaken acceptance thresholds.
- Do not modify retrieval scoring in this loop.
- Generated outputs go to `/tmp`.
- The benchmark is a product quality gate.
- Never write "Loop Complete" in the progress file.
