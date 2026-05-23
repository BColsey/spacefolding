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
- Acceptance checker reports are built through `buildAcceptanceReport`, keeping
  text output, `--json` output, malformed JSON handling, and missing-section
  diagnostics covered without shelling out in Vitest.
- Acceptance checker error handling is covered both through report builders and
  CLI smoke checks for missing input paths, malformed JSON, incomplete summaries,
  and invalid arguments.
- Spec compliance review verifies both the documented command surface and the
  generated JSON/checker contracts, because benchmark scripts and docs share the
  acceptance-gate responsibility.
- Benchmark diagnostic tests cover negative success-gate branches as well as
  passing JSON shape, so failing deltas and missing gate fields remain
  actionable.
- Benchmark CLI parsers reject unknown flags and missing option values before
  running ingest or retrieval work; parser helpers are exported only where tests
  need to lock down the script contract.
- Benchmark scripts that expose testable helpers should guard execution with an
  `isMainModule()` check so imports in Vitest do not run the benchmark.
- Dead-code review for benchmark scripts should include a targeted TypeScript
  pass with `--noUnusedLocals` and `--noUnusedParameters`, because benchmark
  files live outside the main `tsconfig.json` include.
- README test coverage summaries should avoid exact Vitest counts; package
  script output is the source of truth and benchmark diagnostic tests change the
  count frequently.
- Held-out dataset generation should enforce `/tmp` output paths, not only
  refuse repository output paths, so private generated task JSON cannot be
  written to arbitrary local directories by mistake.

## Known Issues

(Issues found during review phase. Highest severity first. Agent resolves these before doing new adversarial reviews.)

## Resolved Issues

(Issues moved here after being fixed and committed.)

## Completed Work Items

- 1. Baseline Measurement Runbook
- 2. Retrieval Benchmark Diagnostics
- 3. E2E Benchmark Diagnostics
- 4. Held-Out Benchmark Safety
- 5. Acceptance Checker Clarity

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
- Work item 5: refactored `benchmarks/check-acceptance.ts` into testable report
  builders, required retrieval and E2E success-gate fields, made malformed JSON
  and missing JSON sections fail as explicit checks, and documented
  machine-readable checker output under `/tmp`. Added Vitest coverage for
  pass/fail text formatting, top-level `passed`/`checks` JSON shape, missing
  sections, and malformed JSON. Verified
  `npm run build && npm run lint && npm test` passed. The documented `npx tsx`
  benchmark commands were blocked in this sandbox by `listen EPERM` on tsx's
  `/tmp` IPC pipe, so equivalent `node --import tsx` commands generated
  `/tmp/spacefolding-eval.json`, `/tmp/spacefolding-e2e.json`, and
  `/tmp/spacefolding-acceptance.json`. The checker passed with retrieval JSON
  only, E2E JSON only, and both files, and failed with direct actual/expected
  messages for malformed and incomplete temporary JSON. No generated benchmark
  JSON appeared in repo status.

## Review Log

(Entries added during review phase: category reviewed, what was checked, what was fixed.)

- Spec Compliance: compared `DESIGN.md` success metrics and benchmark design
  against `IMPLEMENTATION.md` testing/ownership contracts, acceptance/held-out
  docs, retrieval JSON, E2E JSON, and checker output. Verified the local quality
  gate passed; `npx tsx benchmarks/evaluate.ts --strategy all --json >
  /tmp/spacefolding-eval.json` produced the expected retrieval diagnostics;
  `npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json >
  /tmp/spacefolding-e2e.json` hit the sandbox's known `listen EPERM` IPC
  restriction, so the equivalent `node --import tsx` command generated the E2E
  JSON for inspection. The checker passed with exact actual/expected metrics,
  and no spec-compliance defect required code changes.
- Error Handling: reviewed malformed JSON, missing files, missing strategy
  summaries, missing E2E summaries, and CLI argument failures against
  `IMPLEMENTATION.md` section 9. Added acceptance-checker tests for missing JSON
  files and missing CLI input paths. Verified `npm run build && npm run lint &&
  npm test` passed. Also verified `npx tsx benchmarks/check-acceptance.ts
  --json`, missing retrieval JSON, malformed retrieval JSON, and incomplete
  retrieval JSON all exited nonzero with direct actual/expected diagnostics. No
  generated benchmark JSON appeared in repo status.
- Test Coverage: reviewed benchmark helper functions and checker branches
  against `DESIGN.md` benchmark contracts and `IMPLEMENTATION.md` sections 9 and
  10. Added Vitest coverage for structural-underperforms deltas, E2E empty
  comparison rejection, focused-gate threshold/current-delta failures, missing
  retrieval/E2E success-gate fields, missing metric averages, and invalid
  held-out numeric args. Verified `npx vitest run tests/benchmark-acceptance.test.ts
  tests/benchmark-evaluate.test.ts tests/benchmark-e2e.test.ts
  tests/benchmark-heldout.test.ts` and `npm run build && npm run lint && npm
  test` passed. No generated benchmark JSON appeared in repo status. Commit was
  blocked because `.git` is mounted read-only in this environment.
- Code Consistency: reviewed CLI argument parsing and JSON report builder shapes
  across retrieval evaluation, E2E benchmark, acceptance checker, held-out
  generation, and retrieval profiler scripts. Fixed inconsistent argument
  handling so benchmark CLIs reject unknown flags, missing option values, and
  invalid E2E/profiler strategies before running benchmark work; made the
  profiler import-safe for parser tests. Added parser coverage for those
  branches. Verified the focused benchmark tests and
  `npm run build && npm run lint && npm test` passed. Ran
  `npx tsx benchmarks/evaluate.ts --strategy all --json >
  /tmp/spacefolding-eval.json`; the documented E2E `npx tsx` command hit the
  sandbox's known `listen EPERM` IPC restriction, so
  `node --import tsx benchmarks/e2e-benchmark.ts --strategy structural --json >
  /tmp/spacefolding-e2e.json` generated the E2E JSON. The documented acceptance
  checker command passed with exact actual/expected metrics, and no generated
  benchmark JSON appeared in repo status. Commit was blocked because `.git` is
  mounted read-only in this environment.
- Dead Code: reviewed unused benchmark fields, stale docs, and unwired checker
  branches against `DESIGN.md` benchmark design and `IMPLEMENTATION.md` section
  10. Removed an unused retrieval result type, an unused E2E dataset-map
  parameter, and stale E2E bookkeeping for path/chunk lookup and counted
  baseline files that did not feed any metric. Replaced the stale fixed
  benchmark-document count in `README.md` with current benchmark surface
  wording. Verified a targeted benchmark TypeScript unused check passed, then
  verified `npm run build && npm run lint && npm test` passed. No generated
  benchmark JSON appeared in repo status. Commit was blocked because `.git` is
  mounted read-only in this environment.
- Integration Wiring: compared documented benchmark commands in
  `DESIGN.md`, `IMPLEMENTATION.md`, `benchmarks/ACCEPTANCE.md`,
  `benchmarks/HELDOUT.md`, and `README.md` against the real package scripts and
  benchmark CLI parsers. Fixed a stale README exact Vitest count so the docs no
  longer drift from `npm test` output. Verified `npm run build && npm run lint
  && npm test` passed, `npx tsx benchmarks/evaluate.ts --strategy all --json >
  /tmp/spacefolding-eval.json` generated retrieval JSON, the documented E2E
  `npx tsx` command hit the sandbox's known `listen EPERM` IPC restriction, the
  equivalent `node --import tsx` command generated `/tmp/spacefolding-e2e.json`,
  and the documented acceptance checker command passed with exact
  actual/expected metrics. No generated benchmark JSON appeared in repo status.
  Commit was blocked because `.git` is mounted read-only in this environment.
- Security And Data Integrity: reviewed held-out generation, profiler output,
  benchmark JSON shape, `.gitignore`, and tracked benchmark artifacts against
  `DESIGN.md` benchmark design and `IMPLEMENTATION.md` sections 10 and 12.
  Verified no benchmark DB, held-out JSON, private corpus, `data/`, or env files
  are tracked and that benchmark DB/log artifacts are ignored. Fixed held-out
  generation so task JSON is rejected outside `/tmp` as well as inside the repo,
  and updated the held-out docs and tests for that guard. Verified
  `npx vitest run tests/benchmark-heldout.test.ts` and
  `npm run build && npm run lint && npm test` passed. Smoke-tested fixture
  generation to `/tmp/spacefolding-heldout-security-review.json`, verified
  `/var/tmp/spacefolding-heldout-security-review.json` fails with a direct
  message, and confirmed no generated held-out JSON appeared in repo status.
