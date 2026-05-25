# integration-polish - Progress Tracker

## Status: REVIEW

## Codebase Patterns

- Web endpoint tests use `createWebRequestHandler()` directly so Vitest does not
  need to bind a local port in sandboxed environments that reject `listen()`.
- `/api/retrieve` should stay aligned with MCP retrieval diagnostics: selected
  chunk tier, sources, score breakdown, reasons, budget, utilization, omitted
  chunks, compressed summaries, plan, and selection policy.
- The web inspector renders repository-derived paths, text, and stats through
  HTML escaping before inserting with `innerHTML`.
- README benchmark docs should describe gate commands and thresholds instead of
  embedding exact pass results unless the acceptance gate was run in the same
  iteration.
- In this sandbox, `npx tsx benchmarks/e2e-benchmark.ts` may fail with
  `listen EPERM` on `/tmp/tsx-*`; rerun outside the sandbox or with approval
  before treating it as an application failure.

## Known Issues

(Issues found during review phase. Highest severity first. Agent resolves these before doing new adversarial reviews.)

## Resolved Issues

- Spec Compliance review: aligned graph-hop default descriptions across MCP,
  CLI help, README, and the integration guide. Graph traversal is now described
  as disabled by default with `maxHops: 0`, matching `planQuery()` and the CLI
  default.
- Error Handling review: MCP and CLI retrieval controls now reject malformed
  numeric values before they reach the pipeline. CLI `--max-tokens`, `--top-k`,
  `--return-limit`, and `--max-hops` use strict integer parsing; MCP validates
  `maxTokens`, `topK`, `returnLimit`, `maxHops`, and non-empty `query`; web
  `/api/retrieve` has explicit invalid budget coverage.
- Test Coverage review: interface tests now cover CLI invalid mode/strategy
  parsing through the shared parser and web handler 405/404 error branches.
- Code Consistency review: CLI retrieval output now resolves diagnostics for
  compressed chunks the same way MCP and web do, and score output includes the
  graph component alongside structural/vector/FTS/dependency/final.
- Dead Code review: removed unused web inspector client state fields for raw
  score and retrieval results; rendering now keeps only chunks and tier state.
- Integration Wiring review: MCP `iterative_retrieve` now defers strategy
  selection to the pipeline by default, so it uses structural retrieval when
  code symbols are indexed just like `retrieve_context`.
- Security And Data Integrity review: verified generated DB/held-out/env
  artifacts are ignored, no generated benchmark JSON is in repo status, and web
  dynamic HTML uses escaping or `textContent`.
- Code Consistency review: preserved `selectionPolicy.targetBudget` as the
  nominal focused/broad/exhaustive policy target and reports the protected-set
  expanded budget through `selectionPolicy.effectiveBudget` and the top-level
  `targetBudget`.
- Security And Data Integrity review: tightened the web inspector chunk table so
  token estimates are escaped before insertion through `innerHTML`, matching the
  existing path/type/text escaping invariant.

## Completed Work Items

### 1. MCP Retrieval Output Alignment
- `validateArgs` now validates `mode` and `strategy` parameters against allowed enums with clear error messages.
- `validateArgs` exported for direct testing.
- Added 7 new interface tests: schema enum coverage, description presence, invalid mode/strategy rejection, valid acceptance.

### 2. CLI Retrieval Controls
- CLI `retrieve` command validates mode and strategy before calling pipeline.
- Added 3 new CLI tests: option coverage, mode description, default mode.

### 3. Web Inspection
- Added `/api/retrieve` diagnostics with validated `mode`/`maxTokens`, budget
  metadata, score/reason output, omitted chunk details, and compressed summary
  metadata.
- Web UI now exposes retrieval controls, chunk path/type/token columns, top
  per-file stats, retrieval tier/mode/reason output, and an empty repository
  state.
- Added 3 web interface tests covering per-file stats, retrieval diagnostics,
  invalid mode handling, and empty-state HTML.

### 4. Documentation Alignment
- README retrieval sample now matches the CLI hard-budget default, and README
  benchmark docs show `/tmp` acceptance JSON commands, checker thresholds,
  paced Ralph loop usage, and held-out dataset/evaluation commands.
- Configuration docs now list focused, broad, and exhaustive mode behavior with
  current target budgets and CLI/MCP hard-budget defaults.
- Integration guide retrieval response sample now includes path, token estimate,
  score/reason diagnostics, compressed summary metadata, and the current focused
  target budget example.

### 5. Final Acceptance And Wiring Sweep
- Full acceptance gate passed with all 13 checks green.
- Structural retrieval averages: R@10 `0.983333`, NDCG@10 `0.890205`, MRR
  `0.933333`, precision@10 `0.205000`, average results `22.40`.
- E2E focused averages: recall `1.000000`, precision `0.407937`, tokens
  `10906.7`; no task returned more tokens than the full indexed codebase
  (`40618` tokens).
- `git status --short` showed no generated benchmark JSON or DB artifacts.

## Iteration Log

- **68438f9** — Work Item 1: MCP input validation for mode and strategy, plus interface schema and validation tests.
- **5f7a3f8** — Work Item 2: CLI mode/strategy validation and retrieval option tests.
- **096a2b4** — Work Item 3: Web stats and retrieval inspection API/UI plus direct handler
  tests. Verified `npx vitest run tests/interface.test.ts` and
  `npm run build && npm run lint && npm test` passed with 283 tests.
- Work Item 4: Documentation alignment for current retrieval defaults, mode
  behavior, acceptance commands, held-out commands, and one-hour Ralph pacing.
  Manually verified documented CLI flags and benchmark scripts against
  `src/cli/index.ts` and `benchmarks/*.ts`. Verified
  `npm run build && npm run lint && npm test` passed with 283 tests.
- Work Item 5: Final acceptance gate. Verified `npm run build`, generated
  `/tmp/spacefolding-eval.json`, generated `/tmp/spacefolding-e2e.json`, and
  ran `benchmarks/check-acceptance.ts` with both files. The E2E `npx tsx`
  command hit sandbox `listen EPERM` on the first attempt, then passed when run
  outside the sandbox. Acceptance checker passed all 13 checks.

## Review Log

(Entries added during review phase: category reviewed, what was checked, what was fixed.)

- Spec Compliance: compared `DESIGN.md` user surfaces and success metrics plus
  `IMPLEMENTATION.md` retrieval/config/testing contracts against MCP
  `retrieve_context`, CLI `retrieve`, web `/api/retrieve`, README,
  configuration docs, integration guide, and benchmark docs. Verified focused,
  broad, and exhaustive modes are exposed or documented where required; selected
  chunks include plan, budget, tier, source, score, and reason diagnostics on
  MCP/web surfaces; CLI output includes intent, strategy, mode, token budget,
  selected paths, and score breakdown; benchmark docs use `/tmp` artifacts and
  current acceptance commands. No spec-compliance defect required code changes.
  Verified `npm run build && npm run lint && npm test` passed with 283 tests.
- Error Handling: reviewed invalid MCP/CLI retrieval inputs and web
  empty/error states against `IMPLEMENTATION.md` section 9. Fixed loose CLI
  `parseInt` handling that accepted malformed numeric flags, added strict CLI
  parser coverage for `--max-tokens`, `--top-k`, `--return-limit`,
  `--max-hops`, and empty query, tightened MCP validation for retrieval numeric
  controls and query shape, and added web invalid `maxTokens` coverage.
  Verified `npx vitest run tests/interface.test.ts` passed with 19 tests and
  `npm run build && npm run lint && npm test` passed with 287 tests.
- Test Coverage: reviewed MCP, CLI, and web interface coverage for retrieval
  controls and web error states. Added coverage for CLI invalid mode/strategy
  through `parseRetrieveCommandOptions()` and web request-handler 405/404
  branches. Verified `npx vitest run tests/interface.test.ts` passed with 20
  tests and `npm run build && npm run lint && npm test` passed with 288 tests.
- Code Consistency: reviewed naming and retrieval diagnostic output across MCP,
  CLI, and web. Fixed CLI retrieval output so compressed chunk ids are mapped
  back to original retrieval diagnostics like MCP/web, and added the missing
  `graph` score component to the CLI score breakdown. Verified
  `npm run build && npm run lint && npm test` passed with 288 tests.
- Dead Code: reviewed integration-owned surfaces for unused exports, unwired
  retrieval controls, dead client state, and ignored placeholder fields. Removed
  unused web inspector `state.result` and `state.retrievalResult` fields and
  their assignments; no exposed CLI/MCP/web retrieval option was found unwired.
  Verified `npm run build && npm run lint && npm test` passed with 288 tests.
- Integration Wiring: reviewed MCP retrieval tools, CLI retrieve, web retrieve,
  and benchmark/docs wiring for implemented retrieval behavior. Fixed
  `iterative_retrieve` so its default strategy is not forced to the old adaptive
  provider default; it now passes `undefined` to `PipelineOrchestrator.retrieve()`
  per round, preserving the structural-when-indexed default used by
  `retrieve_context`. Tightened `rounds` validation and schema description.
  Verified `npx vitest run tests/interface.test.ts` passed with 21 tests and
  `npm run build && npm run lint && npm test` passed with 289 tests.
- Security And Data Integrity: reviewed web JSON/HTML output, CLI JSON output,
  MCP JSON responses, held-out/profiler output paths, ignored artifacts, and
  tracked files. Verified `.gitignore` covers `data/`, SQLite DB/WAL/SHM files,
  `.env`, and generated held-out JSON; `git ls-files` only reports
  `.env.example` for env files; `git status --short` shows no generated
  benchmark JSON or DB artifacts. No security/data-integrity defect required
  code changes. Verified `npm run build && npm run lint && npm test` passed
  with 289 tests.
- Spec Compliance: performed a fresh sweep of `DESIGN.md` user surfaces and
  retrieval constraints plus `IMPLEMENTATION.md` public interface, retrieval
  behavior, configuration, and testing contracts against MCP `retrieve_context`,
  CLI `retrieve`, web `/api/retrieve`, README, configuration docs, integration
  guide, and benchmark docs. Fixed stale graph-hop descriptions that claimed
  intent-based automatic hops even though graph traversal is disabled by default
  with `maxHops: 0`; updated MCP schema/help/docs and added interface coverage
  for the disabled default. Verified
  `npm run build && npm run lint && npm test` passed with 319 tests.
- Error Handling: performed a fresh sweep of MCP, CLI, and web retrieval error
  paths plus benchmark failure behavior against `IMPLEMENTATION.md` section 9.
  Fixed MCP validation so required tool arguments are enforced before execution:
  retrieval tools now reject missing `query`, ingest tools reject missing
  `path`/`source`/`text`, task tools reject missing `task`, `delete_context`
  rejects empty or non-string chunk IDs, and no-argument `list_context` remains
  valid when MCP clients omit `arguments`. Verified
  `npx vitest run tests/interface.test.ts` passed with 23 tests and
  `npm run build && npm run lint && npm test` passed with 320 tests.
- Test Coverage: performed a fresh sweep of MCP, CLI, web, and docs-sensitive
  retrieval coverage against `DESIGN.md` user surfaces and
  `IMPLEMENTATION.md` section 10. Fixed the remaining CLI coverage gap by
  exercising the real `retrieve` command action against a temporary DB and
  asserting that output includes query, intent, mode, and token-budget usage.
  Verified `npx vitest run tests/interface.test.ts` passed with 24 tests and
  `npm run build && npm run lint && npm test` passed with 321 tests.
- Code Consistency: performed a fresh sweep of retrieval naming across MCP,
  CLI, web, pipeline return objects, policy helpers, docs, and benchmark
  consumers. Fixed `PipelineOrchestrator.retrieve()` so
  `selectionPolicy.targetBudget` keeps the nominal policy target while the
  expanded protected-candidate budget is exposed as
  `selectionPolicy.effectiveBudget` and the top-level user-facing
  `targetBudget`. Added orchestrator regression coverage for expanded focused
  budgets. Verified targeted
  `npx vitest run tests/orchestrator.test.ts --testNamePattern "policy target budget"`
  and `npm run build && npm run lint && npm test` passed with 322 tests.
- Dead Code: performed a fresh sweep for integration-owned retrieval options
  and diagnostics across MCP, CLI, web, pipeline policy helpers, tests, and
  docs, then ran `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`.
  Confirmed mode/strategy/topK/returnLimit/maxHops and budget/reason
  diagnostics remain wired to user surfaces. Removed compiler-detected dead
  declarations in retriever normalization, scorer construction, GPU embedding
  readiness metadata, and LLMLingua compression parameter naming. Verified
  `npm run build && npm run lint && npm test` passed with 322 tests.
- Integration Wiring: performed a fresh sweep of retrieval behavior reaching
  MCP `retrieve_context`/`iterative_retrieve`, CLI `retrieve`, web
  `/api/retrieve` and inspector controls, ranking/E2E/profiler benchmark calls,
  and user docs. Confirmed these surfaces call `PipelineOrchestrator.retrieve()`
  with the intended strategy, mode, budget, topK, return-limit, graph-hop, plan,
  reason, omitted/dropped, and compression diagnostics. No integration wiring
  defect required code changes. Verified
  `npm run build && npm run lint && npm test` passed with 322 tests.
- Security And Data Integrity: performed a fresh sweep of web HTML/JSON output,
  MCP/CLI JSON serialization, benchmark generated-output paths, SQLite scratch
  artifact handling, corpus symlink behavior, `.gitignore`, tracked files, and
  current generated artifacts. Fixed the web inspector chunk table so
  `tokensEstimate` is escaped before `innerHTML` insertion like path, type, and
  text fields. Confirmed tracked files do not include DB/WAL/SHM, `.env`, or
  generated benchmark JSON artifacts; ignored benchmark DB files and `/tmp`
  benchmark JSON outputs remain untracked. Verified
  `npx vitest run tests/interface.test.ts` passed with 25 tests and
  `npm run build && npm run lint && npm test` passed with 323 tests.
