# integration-polish - Autonomous Agent Instructions

## Housekeeping

Ignore:

- `ralph-integration-polish.log`
- `coverage/`
- `benchmarks/*.db`
- `benchmarks/*.db-wal`
- `benchmarks/*.db-shm`
- `/tmp/spacefolding-*.json`

Pre-existing uncommitted changes are not your problem. Only commit files you changed.

## Prime Directive

You are wiring retrieval improvements into the user-facing product. MCP, CLI, web UI, docs, and final acceptance must reflect the same behavior.

This loop should run after measurement, retrieval-ranking, and indexing-chunking have made meaningful progress.

## Authority Hierarchy

1. `DESIGN.md`
2. `IMPLEMENTATION.md`
3. This prompt

## Rules of Engagement

Non-negotiable:

1. Read `progress-integration-polish.md` first.
2. One work item per iteration.
3. Any new runtime option must be exposed consistently in CLI/MCP/docs when relevant.
4. Do not implement a component without making it reachable from a user surface or benchmark.
5. Final work must run the full acceptance gate.

Prohibited:

- No docs for features that are not wired.
- No CLI flags that do nothing.
- No MCP schema drift from implementation behavior.
- No decorative web UI changes unrelated to retrieval inspection.
- No writing "Loop Complete" or "Loop Done" in the progress file.

## Environment

- Working directory: `/home/ben/Documents/Projects/spacefolding`
- Language: TypeScript ESM on Node
- Test framework: Vitest
- Progress file: `progress-integration-polish.md`

## Quality Gate

Run after every code change:

```bash
npm run build && npm run lint && npm test
```

Final acceptance command:

```bash
npm run build
npx tsx benchmarks/evaluate.ts --strategy all --json > /tmp/spacefolding-eval.json
npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json > /tmp/spacefolding-e2e.json
npx tsx benchmarks/check-acceptance.ts \
  --retrieval-json /tmp/spacefolding-eval.json \
  --e2e-json /tmp/spacefolding-e2e.json
```

## Workflow Per Iteration

1. Read `progress-integration-polish.md`.
2. Fix Known Issues first.
3. Otherwise choose the lowest-numbered incomplete work item.
4. Read referenced specs.
5. Implement and test.
6. Run quality gate.
7. Commit only your changes.
8. Update progress.

## Work Items

### 1. MCP Retrieval Output Alignment

Spec sections: `DESIGN.md` "User Surfaces", `IMPLEMENTATION.md` sections 6 and 7.
Files: `src/mcp/server.ts`, `src/types/index.ts`, `tests/interface.test.ts`, `tests/rag.test.ts`.

Deliver:

- `retrieve_context` output exposes selected chunks, plan, budget, total tokens, omitted/compressed chunks, and useful retrieval reasons.
- MCP schemas match the actual returned shape.
- Focused, broad, and exhaustive modes are documented or discoverable through schema descriptions.

Tests:

- MCP retrieve call returns plan and budget metadata.
- Mode option changes selection policy.
- Invalid mode or strategy fails with a useful error.

Done when: MCP users can see why retrieval returned the context it did.

### 2. CLI Retrieval Controls

Spec sections: `DESIGN.md` "User Surfaces", `IMPLEMENTATION.md` section 8.
Files: `src/cli/index.ts`, `README.md`, `tests/interface.test.ts` or CLI-oriented tests.

Deliver:

- CLI retrieval command exposes mode, strategy, max tokens, and topK if not already present.
- CLI output includes intent, strategy, mode, token budget, total tokens, and selected paths.
- Defaults match `PipelineOrchestrator.retrieve()`.

Tests:

- CLI parse accepts focused/broad/exhaustive mode.
- CLI parse rejects invalid mode.
- CLI output includes token usage for a retrieval call.

Done when: local CLI users can exercise the improved retrieval behavior.

### 3. Web Inspection

Spec sections: `DESIGN.md` "User Surfaces", `IMPLEMENTATION.md` section 2.
Files: `src/web/server.ts`, `tests/interface.test.ts` or web tests.

Deliver:

- Web API exposes per-file stats and retrieval diagnostics if missing.
- UI displays chunk type, path, token estimate, tier/mode where available, and retrieval reasons without overwhelming the page.
- No in-app tutorial text; controls should be direct and usable.

Tests:

- Stats endpoint returns per-file chunk count and token totals.
- Retrieval endpoint returns reasons and budget metadata.
- Empty repository renders useful empty state without throwing.

Done when: web inspection helps debug retrieval choices.

### 4. Documentation Alignment

Spec sections: `DESIGN.md` "User Surfaces", `IMPLEMENTATION.md` sections 8 and 10.
Files: `README.md`, `docs/configuration.md`, `docs/integration-guide.md`, `benchmarks/ACCEPTANCE.md`, `benchmarks/HELDOUT.md`.

Deliver:

- Docs describe current commands and actual defaults.
- Docs include `RALPH_SLEEP_SECONDS=3600` for paced autonomous loops.
- Docs explain focused/broad/exhaustive retrieval modes.
- Docs explain acceptance and held-out benchmark usage.

Tests:

- Run `npm run build && npm run lint && npm test`.
- Manually verify documented commands map to real scripts and flags.
- Verify docs do not claim acceptance passes unless it has been run.

Done when: docs match the product users can run.

### 5. Final Acceptance And Wiring Sweep

Spec sections: `DESIGN.md` "Success Metrics", `IMPLEMENTATION.md` sections 10 and 11.
Files: any runtime, benchmark, docs, or tests needed for final failures.

Deliver:

- Run the full acceptance command.
- Fix runtime or benchmark wiring failures until it passes.
- If blocked, put exact failing metrics and the technical blocker in Known Issues.
- Ensure no implemented component is unwired from CLI, MCP, web, or benchmarks.

Tests:

- `npm run build && npm run lint && npm test`
- Full acceptance command.
- `git status --short` shows no generated benchmark JSON or DB artifacts.

Done when: acceptance passes or Known Issues captures exact blockers for the human.

## Review Phase

When all work items are done, enter review. You NEVER write "Loop Complete" or "Loop Done" in `progress-integration-polish.md`.

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

1. Spec Compliance: user surfaces match `DESIGN.md` and `IMPLEMENTATION.md`.
2. Error Handling: MCP/CLI invalid inputs and web empty/error states.
3. Test Coverage: MCP, CLI, web, docs-sensitive behavior where testable.
4. Code Consistency: naming for mode, strategy, budget, and reasons.
5. Dead Code: implemented options not exposed, exposed flags not wired.
6. Integration Wiring: retrieval improvements reachable from CLI, MCP, web, and benchmarks.
7. Security And Data Integrity: path handling, JSON output, no generated artifacts committed.

Known Issues always come first. If you find a defect, fix it.

## Reminders

- A feature that is not wired does not exist.
- Docs must match actual flags and defaults.
- Final acceptance is the product gate.
- Do not commit `/tmp` outputs or benchmark DB files.
- Never write "Loop Complete" in the progress file.
