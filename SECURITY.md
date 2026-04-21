# Security Audit

Date: 2026-04-20
Project: Spacefolding

## Audit Summary

- `npm audit --json`: **0 known vulnerabilities** in the current lockfile on this machine.
- SQL injection review of `src/storage/repository.ts`: **no confirmed SQL injection**. User-controlled values are passed through parameterized statements; the only `db.exec()` call executes static migration strings from `src/storage/schema.ts`.
- Command injection review of all `src/` files: **no uses of** `exec`, `spawn`, `eval`, `Function(...)`, `child_process`, or string-based `setTimeout(...)` in project source.
- Docker review: the container correctly drops to a non-root user in `Dockerfile`, which is a good baseline control.

## Critical Vulnerabilities

- None confirmed during this audit.

## High Severity

### 1. Unbounded MCP and scoring workflows allow CPU / memory denial of service
- **Severity:** High
- **Confidence:** High
- **Affected files:**
  - `src/mcp/server.ts:185-225,255-258`
  - `src/pipeline/orchestrator.ts:41-66,105-129`
  - `src/core/scorer.ts:31-33,71-80`
- **Why this matters:**
  - The MCP handlers pass request data directly into scoring, compression, and ingest flows with no explicit size limits, chunk-count limits, or rate limiting.
  - `processContext()` loads **all chunks** from storage and then scores them.
  - `scoreChunks()` embeds every chunk and also performs an O(n²) redundancy loop across all chunks.
- **Evidence:**
  - `score_context` calls `pipeline.processContext(args!.task ...)` directly in `src/mcp/server.ts:185-188`.
  - `compress_context`, `get_relevant_memory`, `ingest_context`, and `explain_routing` likewise trust `args!` and pass unbounded strings/arrays downstream in `src/mcp/server.ts:191-225,255-258`.
  - `processContext()` calls `this.storage.getAllChunks()` and then compresses/scans the full corpus in `src/pipeline/orchestrator.ts:41-66`.
  - `getRelevantMemory()` also scores the full query result set before trimming to 10 items in `src/pipeline/orchestrator.ts:105-129`.
  - `scoreChunks()` computes embeddings for every chunk and then runs nested redundancy comparisons in `src/core/scorer.ts:31-33,71-80`.
- **Abuse scenario:**
  - A client repeatedly ingests many large chunks, then triggers `score_context` or `get_relevant_memory`. The server will embed and compare the entire corpus, causing high CPU time, large memory usage, and DB growth.
- **Impact:**
  - Service slowdown or unavailability.
  - Resource exhaustion in local or containerized deployments.
  - Amplified impact when real local model embeddings are enabled.

## Medium Severity

### 2. Stored memory has no tenant/session boundary, so shared deployments can leak data across clients
- **Severity:** Medium
- **Confidence:** High
- **Affected files:**
  - `src/storage/schema.ts:3-46`
  - `src/storage/repository.ts:62-87`
  - `src/pipeline/orchestrator.ts:105-129`
  - `README.md:431-436`
- **Why this matters:**
  - The schema stores chunks, routing history, and compression cache globally. There is no user, session, project, or namespace column.
  - Retrieval APIs query the shared corpus and return top matches from that global store.
  - The README explicitly states the app is single-user, so this becomes a real exposure if operators reuse one DB for multiple clients anyway.
- **Evidence:**
  - `chunks`, `routing_history`, and `compression_cache` have no isolation field in `src/storage/schema.ts:3-46`.
  - `queryChunks()` only filters by `source`, `type`, `path`, and `textContains` in `src/storage/repository.ts:62-87`.
  - `getRelevantMemory()` returns top-ranked chunks from whatever the repository query returns in `src/pipeline/orchestrator.ts:105-129`.
  - The product is documented as `Single-user` in `README.md:431-436`.
- **Abuse scenario:**
  - Client A ingests proprietary notes, source code, or secrets into the shared DB. Client B connected to the same DB asks for relevant memory and receives A's data because the retrieval layer has no ownership boundary.
- **Impact:**
  - Cross-session data disclosure.
  - Accidental leakage of code, constraints, or operational notes between users or projects.

### 3. Local model support introduces unpinned runtime supply-chain downloads
- **Severity:** Medium
- **Confidence:** Medium
- **Affected files:**
  - `src/providers/local-embedding.ts:5-6,21-34,55-72`
  - `README.md:123-127,131-137`
  - `package.json:19-24`
- **Why this matters:**
  - The application uses `@huggingface/transformers` and will download model artifacts automatically when a local model is missing.
  - Model selection is controlled by `EMBEDDING_MODEL` / CLI input, but the application does not pin artifact digests or implement its own allowlist.
- **Evidence:**
  - `pipeline('feature-extraction', this.modelId, ...)` is called in `src/providers/local-embedding.ts:21-34` and `downloadModel()` does the same in `src/providers/local-embedding.ts:55-72`.
  - The README documents that models are auto-downloaded on first use in `README.md:125-127` and supports arbitrary HuggingFace model IDs in `README.md:131-137`.
  - The dependency on `@huggingface/transformers` is declared in `package.json:19-24`.
- **Abuse scenario:**
  - An operator points `EMBEDDING_MODEL` at an unexpected or maliciously replaced remote model artifact, or a compromised upstream artifact is fetched during first-run setup.
- **Impact:**
  - Supply-chain trust expansion to remote model hosting.
  - Non-reproducible deployments and unexpected network access at runtime.
  - Increased blast radius if future code starts trusting model metadata or outputs for security decisions.

## Low Severity

### 4. CLI ingest accepts arbitrary readable paths and follows directory traversal outside a repo boundary
- **Severity:** Low
- **Confidence:** High
- **Affected files:**
  - `src/cli/index.ts:63-86`
  - `src/cli/index.ts:210-228`
- **Why this matters:**
  - The CLI accepts any user-supplied path and reads it directly with `statSync()` / `readFileSync()`.
  - Directory walking follows whatever `statSync(fullPath)` resolves to and does not enforce a trusted workspace root.
  - Because `statSync()` follows symlinks, a symlink inside an ingested directory can lead the walker outside the intended tree.
- **Evidence:**
  - `ingest` takes `<path>` from the user and immediately calls `statSync(inputPath)` plus `readFileSync(...)` in `src/cli/index.ts:63-86`.
  - Recursive traversal uses `join(dir, entry)` and `statSync(fullPath)` without `realpath`, `lstat`, or root-boundary checks in `src/cli/index.ts:210-228`.
- **Abuse scenario:**
  - A wrapper or automation job assumes `spacefolding ingest /workspace` only reads repository files. A symlink inside `/workspace` or a direct path like `../../etc/passwd` causes other host files to be read and stored.
- **Impact:**
  - Local file exfiltration into the SQLite corpus.
  - Leakage becomes worse if the shared-memory issue above is also present.
  - This is not a privilege escalation by itself; it is a scope-control weakness.

## Remediation Steps

1. **Add hard input and corpus limits**
   - Reject oversized `task.text`, `text`, `path`, and `chunkIds` payloads in `src/mcp/server.ts`.
   - Cap the number of stored chunks scored per request.
   - Add request timeouts and rate limiting around MCP tool handlers.
   - Refactor scoring to avoid O(n²) redundancy checks across the full corpus.

2. **Introduce namespace isolation**
   - Add `tenantId`, `sessionId`, or `projectId` columns to `chunks`, `routing_history`, and `compression_cache`.
   - Require those identifiers on ingest and retrieval.
   - Enforce them in `queryChunks()` and all MCP handlers.

3. **Harden model supply chain**
   - Prefer pre-downloaded models only.
   - Add an allowlist of approved model IDs.
   - Pin exact model revisions / digests where supported.
   - Disable runtime downloads in production.

4. **Constrain CLI file ingestion**
   - Add an optional `--root` or configured workspace directory and reject paths outside it.
   - Use `realpath()` + prefix checks.
   - Use `lstat()` to detect symlinks and either skip them or require an explicit `--follow-symlinks` flag.

## Non-Findings / Positive Controls

- **SQL injection:** not found in `src/storage/repository.ts`; current queries are parameterized.
- **Command injection:** not found in project source.
- **Dependency audit:** `npm audit --json` returned zero known vulnerabilities for the installed lockfile during this review.
- **Docker user model:** `Dockerfile` switches to `USER appuser`, which is a good baseline control.
