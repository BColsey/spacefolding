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
