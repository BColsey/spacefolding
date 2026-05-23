# measurement - Progress Tracker

## Status: IN PROGRESS

## Codebase Patterns

- Benchmark runbook docs keep generated JSON under `/tmp` so benchmark artifacts
  do not enter repo status.
- `ralph.sh` selects `PROMPT-{loop_name}.md`; measurement pacing uses
  `RALPH_SLEEP_SECONDS=3600 ./ralph.sh measurement codex`.
- Retrieval benchmark JSON is assembled through `buildEvaluationReport`, which
  keeps CLI output shape testable without running the full benchmark in Vitest.
- Retrieval success-gate diagnostics name the required strategy summaries and
  list missing summaries when strict keyword-vs-structural comparison cannot run.
- E2E benchmark JSON is assembled through `buildE2EReport`, which keeps summary
  metrics, current-vs-selected deltas, full-codebase token diagnostics, and the
  focused retrieval success gate testable without running the full pipeline in
  Vitest.
- Held-out dataset generation defaults to `/tmp/spacefolding-heldout-dataset.json`
  and refuses output paths inside the repository checkout, so generated task JSON
  cannot accidentally become a repo artifact.
- The checked-in benchmark fixture corpus can smoke-test held-out generation with
  `--include-tests` because fixture directories are skipped by default.

## Known Issues

(Issues found during review phase. Highest severity first. Agent resolves these before doing new adversarial reviews.)

## Resolved Issues

(Issues moved here after being fixed and committed.)

## Completed Work Items

- 1. Baseline Measurement Runbook
- 2. Retrieval Benchmark Diagnostics
- 3. E2E Benchmark Diagnostics
- 4. Held-Out Benchmark Safety

## Iteration Log

- Work item 1: documented the local quality gate, `/tmp` benchmark artifacts,
  concrete held-out JSON/profiler output paths, and one-hour ralph measurement
  pacing. Verified `npm run build && npm run lint && npm test` passed, manually
  checked documented output paths, and confirmed no generated JSON appeared in
  repo status. Commit was blocked because `.git` is mounted read-only in this
  environment.
- Work item 2: added a testable retrieval evaluation report builder, included
  `requestedStrategies`, per-task `hitDetails`, `retrievedPathCount`, and
  explicit missing strategy summary diagnostics in JSON output. Added Vitest
  coverage for per-strategy averages, hit/miss details, strict success-gate
  deltas, and missing-summary reporting. Verified
  `npm run build && npm run lint && npm test` passed. Ran
  `npx tsx benchmarks/evaluate.ts --strategy all --json > /tmp/spacefolding-eval.json`
  and inspected the JSON keys; no generated benchmark DB or JSON appeared in
  repo status. Commit was blocked because `.git` is mounted read-only in this
  environment.
- Work item 3: added a testable E2E report builder and Vitest coverage for
  average recall, precision, average tokens, codebase-token diagnostics,
  current-vs-structural deltas, tasks returning more tokens than the codebase,
  and `successGate.focusedRetrievalPasses`. Verified
  `npm run build && npm run lint && npm test` passed. The documented `npx tsx`
  command was blocked in this sandbox by `listen EPERM` on tsx's `/tmp` IPC
  pipe, so equivalent `node --import tsx` commands were used to generate
  `/tmp/spacefolding-eval.json` and `/tmp/spacefolding-e2e.json`; the acceptance
  checker passed with both files and reported exact actual/expected metrics. No
  generated benchmark JSON appeared in repo status. Commit was blocked because
  `.git` is mounted read-only in this environment.
- Work item 4: changed held-out dataset generation to default to `/tmp`, added a
  guard that refuses repository output paths, documented profiler comparison
  fields for ingest cost, latency, returned context, and memory, and ignored
  accidental held-out JSON under `benchmarks/`. Added Vitest coverage for the
  `/tmp` default, repo-output guard, and deterministic fixture-corpus generation.
  Verified `npm run build && npm run lint && npm test` passed. Generated a tiny
  public fixture dataset with
  `npx tsx benchmarks/generate-heldout.ts --corpus benchmarks/fixtures --output /tmp/spacefolding-heldout-fixtures.json --limit 5 --include-tests`
  and confirmed no generated held-out JSON appeared in repo status.

## Review Log

(Entries added during review phase: category reviewed, what was checked, what was fixed.)
