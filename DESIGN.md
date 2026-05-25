# Spacefolding Design

Current status: the local quality gate and acceptance gate passed on 2026-05-25 using generated benchmark JSON under `/tmp`. This design remains the product contract; rerun the commands below after changes because benchmark metrics are codebase-state dependent.

## Purpose

Spacefolding is a local-first context management service for coding agents. It ingests project files and working context, indexes them, retrieves the most relevant pieces for a task, and fits the result into a token budget.

The product goal for this ralph loop is not to add another retrieval mechanism for its own sake. The goal is to make the existing retrieval path measurably better for coding-agent work:

- Find the files a developer actually needs.
- Rank the most useful files near the top.
- Return materially fewer tokens than reading the whole codebase.
- Explain why context was selected or dropped.
- Keep MCP, CLI, benchmark, and web behavior aligned.

## Success Metrics

The improvement loop is successful when the local acceptance gate passes:

```bash
npm run build
npx tsx benchmarks/evaluate.ts --strategy all --json > /tmp/spacefolding-eval.json
npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json > /tmp/spacefolding-e2e.json
npx tsx benchmarks/check-acceptance.ts \
  --retrieval-json /tmp/spacefolding-eval.json \
  --e2e-json /tmp/spacefolding-e2e.json
```

Acceptance criteria:

- Structural retrieval beats keyword on `R@10`, `NDCG@10`, and `MRR`.
- Focused E2E retrieval has average recall `>= 0.95`.
- Focused E2E retrieval has average precision `>= 0.35`.
- Focused E2E retrieval returns average tokens `<= 13000`.
- Focused E2E retrieval improves recall, precision, and average tokens versus the current hybrid strategy.
- No E2E task returns more tokens than reading the full indexed codebase.

Normal TypeScript quality gates must continue to pass:

```bash
npm run build
npm run lint
npm test
```

## Current Architecture

Spacefolding has these runtime surfaces:

- CLI entrypoint in `src/main.ts` and `src/cli/index.ts`.
- MCP server in `src/mcp/server.ts`.
- Web server in `src/web/server.ts`.
- Pipeline orchestrator in `src/pipeline/orchestrator.ts`.
- SQLite-backed storage in `src/storage/repository.ts`.
- Benchmarks in `benchmarks/*.ts`.

The core retrieval path is:

1. Project files are ingested by `PipelineOrchestrator.ingest()` or `ingestProject()`.
2. `ContextIngester` creates `ContextChunk` records.
3. `SQLiteRepository.storeChunk()` persists chunks.
4. `PipelineOrchestrator.storeChunkWithEmbedding()` stores embeddings when an embedding provider is available.
5. `PipelineOrchestrator.storeChunkStructure()` stores code symbols and references when language support exists.
6. `PipelineOrchestrator.retrieve()` creates a query plan, runs `HybridRetriever.retrieve()`, applies selection policy, and fills a token budget.
7. MCP and CLI surfaces expose retrieved chunks and metadata.

## Retrieval Design

Retrieval is intentionally hybrid:

- Structural search uses paths, symbols, and references.
- Vector search uses stored chunk embeddings.
- Text search uses FTS5 and lexical fallback.
- Dependency signals may boost directly related chunks.
- Graph traversal is disabled by default unless explicitly selected because previous benchmark evidence showed it can hurt ranking.

Structural retrieval is the preferred strategy when code structure exists. It must combine exact path/symbol matches with semantic and lexical breadth, then return a compact result set for focused mode.

## Query Planning

`planQuery(query)` is responsible for deterministic task analysis:

- Detect intent: `code_search`, `debug`, `explain`, `implement`, or `general`.
- Estimate complexity: `narrow`, `moderate`, or `broad`.
- Select retrieval strategy using provider quality and available structure.
- Recommend topK and token-budget ratio.

Query planning must stay deterministic and local. Do not require cloud LLM calls to retrieve context.

## Selection And Budgeting

Focused retrieval should prefer fewer, higher-confidence chunks. `src/core/retrieval-policy.ts` owns pre-budget candidate selection. `src/core/budget.ts` owns final token-budget filling.

Required invariants:

- Never exceed the hard token budget.
- In focused mode, avoid returning the entire codebase.
- Do not include parent split chunks that only exist as metadata containers.
- Preserve at least a small protected set of top candidates, then apply score and per-path caps.
- Report omitted and dropped candidates with concrete reasons.

## Indexing Design

The storage index has four layers:

- `chunks` table for raw chunk content and metadata.
- `chunk_embeddings` table for stored vector embeddings.
- `chunks_fts` virtual table for FTS5 text search.
- `code_symbols` and `code_references` tables for structural search.

Index updates must be consistent with chunk lifecycle:

- Store chunk before embedding or structure.
- Delete embeddings and code structure when a chunk is deleted.
- Re-ingest changed files without duplicating stale child chunks.
- Preserve content hashes so unchanged split chunks can be reused.

## Benchmark Design

Benchmarks are product tests, not decorative reports.

`benchmarks/evaluate.ts` measures retrieval ranking against labelled relevant files. It compares structural retrieval with keyword, path, FTS, vector, and symbol-only strategies.

`benchmarks/e2e-benchmark.ts` measures developer-task usefulness:

- Did retrieval find expected files?
- How many returned chunks were relevant?
- How many tokens were returned?
- Did focused retrieval improve over current hybrid behavior?

Held-out benchmarks are generated under `/tmp` and must not commit private datasets.

## User Surfaces

All retrieval improvements must be wired into the surfaces users actually call:

- MCP `retrieve_context` and related tools.
- CLI retrieval commands.
- Web inspection endpoints.
- Documentation in `README.md`, `docs/configuration.md`, and `docs/integration-guide.md`.

An implemented component that is not reachable from MCP, CLI, web, or benchmarks is dead code.

## Constraints

- The project is TypeScript ESM on Node.
- Runtime storage is SQLite via `better-sqlite3`.
- Tests use Vitest.
- Retrieval must work without network access.
- Deterministic embedding mode must remain supported.
- GPU and local embedding providers may improve quality but cannot be required for tests.
- Generated benchmark JSON belongs in `/tmp`, not the repository.

## Non-Goals

This loop does not require:

- A hosted service.
- Cloud-only retrieval.
- Human participant studies.
- Replacing SQLite with another database.
- Rewriting the product around a new framework.
