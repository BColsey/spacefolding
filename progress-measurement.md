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
- Secondary benchmark scripts should follow the same strict `parseArgs` and
  `isMainModule()` pattern as the acceptance-gate scripts, so parser tests can
  cover bad flags without starting expensive benchmark work.
- Dead-code review for benchmark scripts should include a targeted TypeScript
  pass with `--noUnusedLocals` and `--noUnusedParameters`, because benchmark
  files live outside the main `tsconfig.json` include.
- README test coverage summaries should avoid exact Vitest counts; package
  script output is the source of truth and benchmark diagnostic tests change the
  count frequently.
- Held-out dataset generation should enforce `/tmp` output paths, not only
  refuse repository output paths, so private generated task JSON cannot be
  written to arbitrary local directories by mistake.
- Held-out output validation must resolve parent directories and reject output
  file symlinks, so `/tmp` symlinks cannot write generated task JSON back into
  the checkout.
- Acceptance checker tests should cover malformed root shapes, missing top-level
  sections, and full-codebase token violations in addition to happy-path gate
  output, because those branches produce the actionable diagnostics other loops
  rely on.
- Benchmark CLI numeric options should use digits-only positive safe-integer
  parsing, because `parseInt` silently accepts malformed values like `1.5` or
  `5abc`.
- Dynamic benchmark providers should be typed against the full provider
  contract they are passed into; the ablation benchmark needs both `embed` and
  `embedBatch` so vector-only and full-pipeline paths stay compile-checkable.
- Benchmark scripts should validate dataset root shape and required task fields
  before dereferencing `tasks`, so malformed held-out JSON fails with a direct
  message instead of a TypeError stack.
- Profiler dataset loading should wrap file reads and JSON parsing in a helper
  before validation, so malformed held-out JSON reports the dataset path instead
  of a raw `SyntaxError` stack.
- Acceptance checker helper tests should cover the `buildAcceptanceReport`
  no-input fallback even though CLI parsing usually prevents that state, because
  report builders are reused directly in tests and diagnostics.
- Legacy benchmark generators should be import-safe and use strict option
  parsing before writing files, because parser tests cannot cover them if module
  import triggers generation.
- Legacy benchmark task generation should enforce `/tmp` output paths and reject
  symlinked output parents, not only default there, because `--sources` can point
  at private local corpora.
- Benchmark dataset loader tests should cover malformed JSON files, not only
  parsed malformed objects, because loader diagnostics must include the failing
  dataset path.
- Benchmark scripts should sort walked source files before ingesting or
  generating tasks, because raw filesystem iteration order can make fixed
  dataset/corpus measurements drift.
- Benchmark CLI parsers should reject undocumented positional arguments; the
  documented flag surface is the contract other loops can rely on.
- Security reviews should check tracked files with `git ls-files` and ignore
  rules with `git check-ignore`, because local ignored benchmark DB artifacts may
  exist without being part of the commit surface.
- Spec compliance review should inspect generated JSON key sets as well as the
  checker result, because a passing gate still needs to preserve the diagnostic
  fields promised by the benchmark contracts.
- Error-handling smoke tests should include both checker JSON failures and
  benchmark process failures, because acceptance diagnostics and script startup
  diagnostics have different output paths.
- Dead-code reviews should compare result snapshot docs against freshly
  generated `/tmp` benchmark JSON, because stale metric tables are dead
  diagnostic surface even when checker code is fully wired.
- Benchmark scratch SQLite databases should use a shared `/tmp` temp-artifact
  helper and remove `-wal`/`-shm` sidecars, because ignored repo-local DB files
  still pollute the worktree and can hide artifact-location drift.
- Git ignore rules should include all loop housekeeping artifacts, including
  `coverage/`, so local quality-gate output cannot accidentally become commit
  surface.

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
- Spec Compliance: rechecked `DESIGN.md` success metrics and benchmark design
  against `IMPLEMENTATION.md` testing/ownership contracts, acceptance and
  held-out docs, retrieval JSON, E2E JSON, and checker output. Verified
  `npm run build && npm run lint && npm test` passed, generated retrieval JSON
  with `npx tsx benchmarks/evaluate.ts --strategy all --json >
  /tmp/spacefolding-eval.json`, and inspected the required retrieval diagnostic
  keys. The documented E2E `npx tsx` command hit the sandbox's known
  `listen EPERM` IPC restriction, so `node --import tsx` generated
  `/tmp/spacefolding-e2e.json`; the E2E JSON included focused summary metrics,
  current-vs-structural deltas, full-codebase token diagnostics, and the
  focused success gate. The documented acceptance checker command passed with
  exact actual/expected metrics, and no generated benchmark JSON appeared in
  repo status. No spec-compliance defect required code changes.
- Error Handling: reviewed malformed JSON, missing files, missing strategy
  summaries, missing E2E summaries, and benchmark process failures against
  `IMPLEMENTATION.md` section 9. Verified acceptance checker smoke cases for
  malformed retrieval JSON, incomplete retrieval summaries, incomplete E2E
  summaries, and missing E2E JSON all exited nonzero with direct
  actual/expected diagnostics. Verified benchmark CLI failures for unknown
  retrieval arguments, invalid E2E strategy, missing retrieval dataset, missing
  E2E dataset, and missing profiler dataset all exited nonzero and named the
  failing argument or path. Verified `npm run build && npm run lint && npm
  test` passed. No error-handling defect required code changes.
- Test Coverage: reviewed benchmark helper functions and checker branches
  against `DESIGN.md` benchmark contracts and `IMPLEMENTATION.md` section 10.
  Added Vitest coverage for non-object retrieval JSON, missing retrieval
  strategies arrays, missing E2E summaries, checker unknown flags, and E2E tasks
  returning more tokens than the full codebase. Verified
  `npx vitest run tests/benchmark-acceptance.test.ts` and
  `npm run build && npm run lint && npm test` passed. No generated benchmark
  JSON appeared in repo status.
- Code Consistency: reviewed CLI parsing and report-shape consistency across
  benchmark scripts against `DESIGN.md` benchmark design and
  `IMPLEMENTATION.md` sections 9 and 10. Fixed held-out generation and
  retrieval profiler numeric parsing so malformed values such as `1.5` and
  `12000abc` fail before benchmark work runs. Added parser coverage for those
  branches. Verified `npx vitest run tests/benchmark-profile.test.ts
  tests/benchmark-heldout.test.ts` and `npm run build && npm run lint && npm
  test` passed. Smoke-tested fixture held-out generation to
  `/tmp/spacefolding-heldout-code-consistency.json`, and verified malformed
  held-out/profiler numeric arguments exited nonzero with direct messages.
- Dead Code: reviewed unused benchmark fields, stale docs, and unwired checker
  branches against `DESIGN.md` benchmark design and `IMPLEMENTATION.md` section
  10. The targeted benchmark TypeScript unused check found dead/under-typed code
  in `benchmarks/ablation.ts`; removed the unused dataset-flag callback
  parameter and typed the dynamic embedding provider contract so vector-only and
  full-pipeline strategies remain checked. Verified
  `npx tsc -p benchmarks/tsconfig.json --noEmit --noUnusedLocals
  --noUnusedParameters` and `npm run build && npm run lint && npm test` passed.
  No generated benchmark JSON appeared in repo status.
- Integration Wiring: compared documented benchmark commands in `DESIGN.md`,
  `IMPLEMENTATION.md`, `benchmarks/ACCEPTANCE.md`, `benchmarks/HELDOUT.md`, and
  `README.md` against `package.json` scripts and the benchmark CLI parsers.
  Verified the documented retrieval, E2E, acceptance-checker, held-out, profiler,
  and ralph pacing commands still use supported flags and concrete `/tmp` output
  paths. Verified `npm run build && npm run lint && npm test` passed, generated
  retrieval JSON with `npx tsx benchmarks/evaluate.ts --strategy all --json >
  /tmp/spacefolding-eval.json`, and confirmed the expected retrieval diagnostic
  keys. The documented E2E `npx tsx` command hit the sandbox's known
  `listen EPERM` IPC restriction, so `node --import tsx` generated
  `/tmp/spacefolding-e2e.json`; the documented checker command passed with exact
  actual/expected metrics. No generated benchmark JSON appeared in repo status,
  and no integration-wiring defect required code changes.
- Security And Data Integrity: reviewed held-out generation, profiler output,
  ignored artifacts, and tracked benchmark/env/data files against `DESIGN.md`
  benchmark design and `IMPLEMENTATION.md` sections 10 and 12. Fixed held-out
  output validation so `/tmp` symlink parents cannot write generated task JSON
  back into the checkout, and added a regression test for that path. Verified no
  generated DB files, held-out JSON, private corpus, `data/`, or `.env` files
  are tracked and that git ignores benchmark DB and held-out JSON artifacts.
  Verified `npx vitest run tests/benchmark-heldout.test.ts` and
  `npm run build && npm run lint && npm test` passed. Smoke-tested fixture
  generation to `/tmp/spacefolding-heldout-security-symlink-review.json`; the
  equivalent symlink-rejection CLI check passed with `node --import tsx` after
  the sandbox hit its known `npx tsx` IPC restriction. No generated held-out JSON
  appeared in repo status.
- Spec Compliance: rechecked `DESIGN.md` success metrics and benchmark design
  against `IMPLEMENTATION.md` testing/ownership contracts, acceptance docs,
  retrieval JSON, E2E JSON, and checker output. Verified
  `npm run build && npm run lint && npm test` passed, generated retrieval JSON
  with `npx tsx benchmarks/evaluate.ts --strategy all --json >
  /tmp/spacefolding-eval.json`, and confirmed per-strategy diagnostics,
  hit/miss details, and `successGate.structuralBeatsKeyword` were present. The
  documented E2E `npx tsx` command hit the sandbox's known `listen EPERM` IPC
  restriction, so `node --import tsx` generated `/tmp/spacefolding-e2e.json`;
  the E2E JSON included focused summary metrics, current-vs-structural deltas,
  full-codebase token diagnostics, and `successGate.focusedRetrievalPasses`.
  The documented acceptance checker command passed with exact actual/expected
  metrics, and no generated benchmark JSON appeared in repo status. No
  spec-compliance defect required code changes.
- Error Handling: reviewed malformed JSON, missing files, missing strategy
  summaries, missing E2E summaries, dataset shape validation, and benchmark
  process failures against `IMPLEMENTATION.md` section 9. Fixed retrieval
  evaluation, E2E benchmark, and retrieval profiler dataset loaders so missing
  `tasks` arrays, empty task lists, and malformed task fields fail before
  benchmark work runs with direct messages. Added Vitest coverage for those
  malformed dataset branches. Verified `npx vitest run
  tests/benchmark-evaluate.test.ts tests/benchmark-e2e.test.ts
  tests/benchmark-profile.test.ts` and `npm run build && npm run lint && npm
  test` passed. Smoke-tested malformed dataset CLI failures for retrieval, E2E,
  and profiler JSON. Generated retrieval JSON with
  `npx tsx benchmarks/evaluate.ts --strategy all --json >
  /tmp/spacefolding-eval.json`; the documented E2E `npx tsx` command hit the
  sandbox's known `listen EPERM` IPC restriction, so `node --import tsx`
  generated `/tmp/spacefolding-e2e.json`. The documented acceptance checker
  command passed with exact actual/expected metrics, and no generated benchmark
  JSON appeared in repo status. Commit was blocked because `.git/index.lock`
  could not be created on the read-only git metadata filesystem.
- Test Coverage: reviewed benchmark helper functions and checker branches
  against `DESIGN.md` benchmark design and `IMPLEMENTATION.md` sections 9 and
  10. Added Vitest coverage for the acceptance checker report-builder no-input
  fallback so direct helper calls still produce an actionable `cli.inputs_present`
  diagnostic. Verified `npx vitest run tests/benchmark-acceptance.test.ts` and
  `npm run build && npm run lint && npm test` passed. No generated benchmark
  JSON appeared in repo status.
- Code Consistency: reviewed CLI parsing and benchmark script import behavior
  across the measurement-owned benchmark surfaces against `DESIGN.md` benchmark
  design and `IMPLEMENTATION.md` sections 9 and 10. Fixed
  `benchmarks/generate-tasks.ts` so it no longer writes output on import,
  rejects unknown flags, missing option values, and malformed counts before
  generation, and defaults generated task JSON to `/tmp`. Added parser/import
  coverage in `tests/benchmark-generate-tasks.test.ts`. Verified
  `npx vitest run tests/benchmark-generate-tasks.test.ts` and
  `npm run build && npm run lint && npm test` passed. Smoke-tested fixture task
  generation to `/tmp/spacefolding-generated-tasks-code-consistency.json` and
  verified malformed `--count 1.5` fails with a direct message. No generated
  benchmark JSON appeared in repo status.
- Dead Code: reviewed unused benchmark fields, stale docs, and unwired checker
  branches against `DESIGN.md` benchmark design and `IMPLEMENTATION.md` section
  10. The targeted benchmark TypeScript unused check passed, but the review
  found stale result docs: `benchmarks/RESULTS.md`, `benchmarks/E2E-RESULTS.md`,
  and the README benchmark table no longer matched the generated acceptance JSON.
  Refreshed those docs with current retrieval and E2E summaries generated under
  `/tmp`. Verified `npx tsc -p benchmarks/tsconfig.json --noEmit
  --noUnusedLocals --noUnusedParameters`, `npm run build && npm run lint && npm
  test`, and the documented acceptance checker command passed. The documented
  E2E `npx tsx` command still hit the sandbox's known `listen EPERM` IPC
  restriction, so `node --import tsx` generated `/tmp/spacefolding-e2e.json` for
  inspection. No generated benchmark JSON appeared in repo status. Commit was
  blocked because `.git/index.lock` could not be created on the read-only git
  metadata filesystem.
- Integration Wiring: compared documented benchmark commands in `DESIGN.md`,
  `IMPLEMENTATION.md`, `benchmarks/ACCEPTANCE.md`, `benchmarks/HELDOUT.md`, and
  `README.md` against `package.json` scripts and benchmark CLI parsers. Verified
  the documented retrieval, E2E, acceptance-checker, held-out, profiler, and
  ralph pacing commands still use supported flags and concrete `/tmp` output
  paths. Verified `npm run build && npm run lint && npm test` passed, generated
  retrieval JSON with `npx tsx benchmarks/evaluate.ts --strategy all --json >
  /tmp/spacefolding-eval.json`, and confirmed the README metrics still match
  the generated summaries. The documented E2E and profiler `npx tsx` commands
  hit the sandbox's known `listen EPERM` IPC restriction, so equivalent
  `node --import tsx` commands generated `/tmp/spacefolding-e2e.json` and
  `/tmp/spacefolding-heldout-profile-integration-wiring.json` for inspection.
  The documented acceptance checker command passed with exact actual/expected
  metrics, fixture held-out generation wrote only to `/tmp`, and no generated
  benchmark JSON appeared in repo status. No integration-wiring defect required
  code changes. Commit was blocked because `.git/index.lock` could not be
  created on the read-only git metadata filesystem.
- Security And Data Integrity: reviewed held-out generation, legacy task
  generation, profiler output, ignored artifacts, and tracked benchmark/env/data
  files against `DESIGN.md` benchmark design and `IMPLEMENTATION.md` sections 10
  and 12. Fixed `benchmarks/generate-tasks.ts` so generated benchmark task JSON
  is rejected outside `/tmp`, inside the repository, and through `/tmp` symlink
  parents before any corpus scan or write. Added regression coverage in
  `tests/benchmark-generate-tasks.test.ts`. Verified
  `npx vitest run tests/benchmark-generate-tasks.test.ts
  tests/benchmark-heldout.test.ts` and `npm run build && npm run lint && npm
  test` passed. Smoke-tested fixture task generation to
  `/tmp/spacefolding-generated-tasks-security-review.json`, verified repository
  and `/var/tmp` output paths fail with direct messages, and confirmed no
  generated benchmark JSON appeared in repo status. Commit was blocked because
  `.git/index.lock` could not be created on the read-only git metadata
  filesystem.
- Spec Compliance: rechecked `DESIGN.md` success metrics and benchmark design
  against `IMPLEMENTATION.md` testing/ownership contracts, acceptance and
  held-out docs, retrieval JSON, E2E JSON, and checker output. Verified
  `npm run build && npm run lint && npm test` passed, generated retrieval JSON
  with `npx tsx benchmarks/evaluate.ts --strategy all --json >
  /tmp/spacefolding-eval.json`, and confirmed per-strategy summaries,
  hit/miss diagnostics, and `successGate.structuralBeatsKeyword` were present.
  The documented E2E `npx tsx` command hit the sandbox's known `listen EPERM`
  IPC restriction, so `node --import tsx` generated
  `/tmp/spacefolding-e2e.json`; the E2E JSON included focused summary metrics,
  current-vs-structural deltas, full-codebase token diagnostics, and
  `successGate.focusedRetrievalPasses`. The documented acceptance checker
  command passed with exact actual/expected metrics, and no generated benchmark
  JSON appeared in repo status. No spec-compliance defect required code changes.
  Commit was blocked because `.git/index.lock` could not be created on the
  read-only git metadata filesystem.
- Error Handling: reviewed malformed JSON, missing files, missing strategy
  summaries, missing E2E summaries, and profiler process failures against
  `IMPLEMENTATION.md` section 9. Fixed `benchmarks/profile-retrieval.ts` so
  malformed profiler datasets report `Malformed profiler dataset JSON at
  <path>` instead of a raw `SyntaxError` stack, and added coverage in
  `tests/benchmark-profile.test.ts`. Verified `npx vitest run
  tests/benchmark-profile.test.ts` and `npm run build && npm run lint && npm
  test` passed. Smoke-tested malformed acceptance JSON, incomplete retrieval
  summaries, malformed profiler JSON, and missing profiler dataset paths; all
  exited nonzero with direct diagnostics. No generated benchmark JSON appeared
  in repo status. Commit was blocked because `.git/index.lock` could not be
  created on the read-only git metadata filesystem.
- Test Coverage: reviewed benchmark helper functions and checker branches
  against `DESIGN.md` benchmark design and `IMPLEMENTATION.md` section 10. Added
  Vitest coverage for retrieval and E2E dataset loader malformed-JSON paths, so
  file-level parse failures now match the profiler coverage and include the
  failing dataset path. Verified `npx vitest run
  tests/benchmark-evaluate.test.ts tests/benchmark-e2e.test.ts` and
  `npm run build && npm run lint && npm test` passed. No generated benchmark
  JSON appeared in repo status. Commit was blocked because `.git/index.lock`
  could not be created on the read-only git metadata filesystem.
- Code Consistency: reviewed benchmark CLI parsing, source-file traversal, and
  deterministic sampling against `DESIGN.md` benchmark design and
  `IMPLEMENTATION.md` sections 9 and 10. Fixed retrieval evaluation to reject
  undocumented positional strategy arguments, sorted source walks in retrieval
  evaluation, E2E, legacy task generation, ablation, and compression comparison,
  and replaced remaining random bootstrap/sample selection in secondary
  benchmarks with seeded deterministic selection. Added parser coverage for the
  retrieval positional-argument rejection. Verified `npx vitest run
  tests/benchmark-evaluate.test.ts tests/benchmark-generate-tasks.test.ts`,
  `npx tsc -p benchmarks/tsconfig.json --noEmit`, and `npm run build && npm
  run lint && npm test` passed. Generated retrieval JSON with
  `npx tsx benchmarks/evaluate.ts --strategy all --json >
  /tmp/spacefolding-eval.json`; the documented E2E `npx tsx` command hit the
  sandbox's known `listen EPERM` IPC restriction, so `node --import tsx`
  generated `/tmp/spacefolding-e2e.json`. The documented acceptance checker
  command passed with exact actual/expected metrics, and no generated benchmark
  JSON appeared in repo status. Commit was blocked because `.git/index.lock`
  could not be created on the read-only git metadata filesystem.
- Dead Code: reviewed unused benchmark fields, stale result docs, and unwired
  checker branches against `DESIGN.md` benchmark design and
  `IMPLEMENTATION.md` section 10. The targeted benchmark TypeScript unused
  check passed. Refreshed `benchmarks/RESULTS.md`,
  `benchmarks/E2E-RESULTS.md`, and the README benchmark summary from current
  `/tmp` benchmark JSON so documented metrics match the acceptance checker
  inputs. Verified `npx tsc -p benchmarks/tsconfig.json --noEmit
  --noUnusedLocals --noUnusedParameters`, `npx tsx
  benchmarks/check-acceptance.ts --retrieval-json /tmp/spacefolding-eval.json
  --e2e-json /tmp/spacefolding-e2e.json`, and `npm run build && npm run lint
  && npm test` passed. No generated benchmark JSON appeared in repo status.
- Integration Wiring: compared documented benchmark commands in `DESIGN.md`,
  `IMPLEMENTATION.md`, `benchmarks/ACCEPTANCE.md`, `benchmarks/HELDOUT.md`, and
  `README.md` against `package.json` scripts and benchmark CLI parsers. Verified
  the documented retrieval, E2E, acceptance-checker, held-out, profiler, and
  ralph pacing commands still use supported flags and concrete `/tmp` output
  paths. Verified `npm run build && npm run lint && npm test` passed, generated
  retrieval JSON with `npx tsx benchmarks/evaluate.ts --strategy all --json >
  /tmp/spacefolding-eval.json`, generated E2E JSON with `npx tsx
  benchmarks/e2e-benchmark.ts --strategy structural --json >
  /tmp/spacefolding-e2e.json`, and confirmed the documented acceptance checker
  command passed with exact actual/expected metrics. Smoke-tested fixture
  held-out generation, held-out evaluation, and profiler JSON under `/tmp`, and
  verified `bash -n ralph.sh` passed. No integration-wiring defect required code
  changes, and no generated benchmark JSON appeared in repo status.
- Security And Data Integrity: reviewed held-out generation, legacy task
  generation, profiler output, ignored artifacts, and tracked benchmark/env/data
  files against `DESIGN.md` benchmark design and `IMPLEMENTATION.md` sections 10
  and 12. Verified generated held-out and task JSON are still constrained to
  `/tmp`, `/var/tmp` outputs fail with direct messages, benchmark DB artifacts
  are ignored, and no private corpus, `data/`, `.env`, generated JSON, or DB
  files are tracked. Verified `npx vitest run tests/benchmark-heldout.test.ts
  tests/benchmark-generate-tasks.test.ts tests/benchmark-profile.test.ts` and
  `npm run build && npm run lint && npm test` passed. Smoke-tested fixture
  held-out generation to `/tmp/spacefolding-heldout-security-data-review.json`
  and fixture task generation to
  `/tmp/spacefolding-generated-tasks-security-data-review.json`; no generated
  benchmark JSON appeared in repo status. No security/data-integrity defect
  required code changes.
- Spec Compliance: cycled back through the acceptance contract after the latest
  security/data-integrity review. Re-read `DESIGN.md` success metrics and
  benchmark design plus `IMPLEMENTATION.md` testing strategy, loop ownership,
  and v1 constraints. Verified `npm run build && npm run lint && npm test`
  passed. Ran the documented `npx tsx benchmarks/evaluate.ts --strategy all
  --json > /tmp/spacefolding-eval.json`,
  `npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json >
  /tmp/spacefolding-e2e.json`, and checker commands. The checker passed with
  exact actual/expected metrics, including structural-vs-keyword deltas,
  focused retrieval thresholds, current-vs-structural improvements, and the
  no-task-exceeds-codebase-token check. Confirmed generated acceptance JSON
  stayed under `/tmp` and did not appear in repo status. No spec-compliance
  defect required code changes.
- Error Handling: reviewed malformed JSON, missing files, missing strategy
  summaries, missing E2E summaries, and benchmark process failures against
  `IMPLEMENTATION.md` section 9. Verified `npm run build && npm run lint &&
  npm test` passed. Smoke-tested malformed retrieval JSON, incomplete
  retrieval/E2E summaries, missing E2E JSON, and missing checker argument
  values; checker failures exited nonzero with direct actual/expected messages,
  and `--json` output preserved top-level `passed` plus `checks`. Smoke-tested
  missing retrieval, E2E, and profiler datasets; each failed nonzero and named
  the failing dataset path. No error-handling defect required code changes, and
  no generated benchmark JSON appeared in repo status.
- Test Coverage: reviewed benchmark helper functions and checker branches
  against `DESIGN.md` benchmark design and `IMPLEMENTATION.md` sections 9 and
  10. Confirmed the measurement tests cover acceptance report formatting and
  missing-section diagnostics, retrieval per-strategy and missing-summary
  diagnostics, E2E focused-gate and full-codebase token diagnostics, held-out
  and generated-task `/tmp` output guards, malformed dataset loaders, and
  profiler CLI parsing. Verified `npx vitest run
  tests/benchmark-acceptance.test.ts tests/benchmark-evaluate.test.ts
  tests/benchmark-e2e.test.ts tests/benchmark-heldout.test.ts
  tests/benchmark-profile.test.ts tests/benchmark-generate-tasks.test.ts` and
  `npm run build && npm run lint && npm test` passed. No test-coverage defect
  required code changes.
- Code Consistency: reviewed CLI parsing and import behavior across benchmark
  scripts against `DESIGN.md` benchmark design and `IMPLEMENTATION.md` sections
  9 and 10. Fixed secondary ablation and compression benchmark scripts so they
  use strict exported `parseArgs` helpers, reject unknown flags and missing
  `--dataset` values before benchmark work starts, and guard execution with
  `isMainModule()` for import-safe tests. Added Vitest coverage in
  `tests/benchmark-secondary-cli.test.ts`. Verified `npx vitest run
  tests/benchmark-secondary-cli.test.ts`, `npx tsc -p benchmarks/tsconfig.json
  --noEmit`, and `npm run build && npm run lint && npm test` passed.
  Smoke-tested `npx tsx benchmarks/ablation.ts --dataset` and
  `npx tsx benchmarks/compression-comparison.ts --dataset /tmp/tasks.json`;
  both exited nonzero with direct parser messages. No generated benchmark JSON
  appeared in repo status.
- Dead Code: reviewed unused benchmark fields, stale result docs, and unwired
  checker branches against `DESIGN.md` benchmark design and
  `IMPLEMENTATION.md` section 10. The targeted benchmark TypeScript unused
  check passed. Fresh `/tmp` retrieval and E2E JSON showed
  `benchmarks/RESULTS.md` and `benchmarks/E2E-RESULTS.md` were stale, so those
  result snapshots were refreshed from the generated acceptance inputs. Verified
  `npm run build && npm run lint && npm test`, `npx tsc -p
  benchmarks/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`, and
  the documented acceptance checker command passed. No generated benchmark JSON
  appeared in repo status.
- Integration Wiring: compared documented benchmark artifact expectations in
  `DESIGN.md`, `IMPLEMENTATION.md`, `benchmarks/ACCEPTANCE.md`,
  `benchmarks/HELDOUT.md`, and `README.md` against the real benchmark scripts
  and ignore rules. Fixed retrieval evaluation, E2E, profiler, ablation, and
  compression benchmark scratch SQLite paths so generated DBs use `/tmp` and
  remove `-wal`/`-shm` sidecars; added `coverage/` to `.gitignore` to match loop
  housekeeping. Added temp-artifact helper coverage in
  `tests/benchmark-secondary-cli.test.ts`. Verified `npx vitest run
  tests/benchmark-secondary-cli.test.ts tests/benchmark-evaluate.test.ts
  tests/benchmark-e2e.test.ts tests/benchmark-profile.test.ts`,
  `npx tsc -p benchmarks/tsconfig.json --noEmit`, and
  `npm run build && npm run lint && npm test` passed. Ran the documented
  retrieval, E2E, and acceptance-checker commands with JSON under `/tmp`, and
  smoke-tested fixture profiler JSON under `/tmp`; no generated benchmark JSON
  appeared in repo status.
