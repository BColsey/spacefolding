# Changelog

All notable changes to Spacefolding are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) once it reaches 1.0.

## [Unreleased]

### Retrieval credibility & correctness (Phase 0)

- **Removed benchmark contamination.** Deleted the hardcoded `TERM_EXPANSIONS` /
  `PHRASE_EXPANSIONS` query-expansion tables in `src/core/retriever.ts` that mapped
  generic English words to this repository's own symbol names (e.g. `auth`/`401` →
  `scorer`, `router`; `embedding providers` → `EmbeddingProvider`). These inflated
  in-repo benchmark scores (train-on-test) and added noise on any other codebase.
  Sparse query terms now derive solely from the query (tokens, identifiers,
  split-identifier parts, and conservative stems). The four unit tests that asserted
  the contaminated behavior were removed.
- **Fixed a corrupting stemmer** that turned `string` → `str` and `bytes` → `byt`
  (added a code-word denylist and a minimum-stem-length guard).
- **Unified embedding-quality detection.** Added an `EmbeddingQuality` tier to the
  `EmbeddingProvider` interface and all providers; the retriever now reads it instead
  of a `constructor.name` check that broke under minification and disagreed with the
  query planner's env-var path.
- **Weighted Reciprocal Rank Fusion (RRF) replaces min-max score fusion.** The hybrid
  retriever previously min-max normalized each source's raw scores and summed
  `normalizedScore × weight`. That was not scale-free: a source whose raw scores
  happened to span a wider range dominated regardless of agreement (cosine ~0..1,
  BM25 negative log-odds, and structural integers are incommensurate). Fusion is now
  rank-based: a chunk at 1-based rank `r` in a source contributes `weight / (60 + r)`,
  accumulated across sources (`src/core/retriever.ts`). The per-source `sourceScores`
  breakdown now reports each source's RRF contribution and `final` is their sum. Added
  an **absolute relevance floor applied before ranking** — vector results below cosine
  0.2 and structural/dependency results with score ≤ 0 are dropped, so when no source
  has an above-floor hit `retrieve()` returns `[]` instead of top-K noise (FTS/BM25
  presence is kept as its own relevance signal). The exact-identifier structural boost
  and the reranker's exact-structural / reranker-score contributions were rescaled to
  the RRF magnitude so they promote without overwhelming multi-source agreement.
  Benchmark (deterministic embeddings, in-repo dataset): structural held/improved
  (NDCG@10 0.720→0.726, MRR 0.689→0.697, Hits@1 0.526, Hits@5 0.895, R@10 0.873
  unchanged); BM25 is a standalone lexical baseline unaffected by the fusion path.

### Embedding model

- **Code-specific embedding model is now the recommended high-quality default.** The
  `gpu` provider (Python `sentence-transformers` sidecar, `src/providers/gpu-embedding.ts`)
  now defaults to `Salesforce/SFR-Embedding-Code-400M_R` (open weights, strong on code
  retrieval, CPU-feasible) instead of the general `Alibaba-NLP/gte-modernbert-base`.
  Updated in `getDefaultEmbeddingModel()` (`src/cli/index.ts`), the orchestrator's
  `defaultEmbeddingModelForProvider()` (`src/pipeline/orchestrator.ts`), the
  `GpuEmbeddingProvider` constructor default, and the `GPU_EMBEDDING_MODEL` docs/comments.
  This runs **locally** on GPU or CPU (`GPU_EMBEDDING_DEVICE=cpu`).
- The transformers.js `local` default is **unchanged** (`Xenova/bge-small-en-v1.5`) and
  documented as the lightweight, zero-dependency ONNX fallback; the highest-quality
  local-first path is `EMBEDDING_PROVIDER=gpu` with the code model. No model is downloaded
  in CI/tests (the deterministic provider is used there), so the test suite stays offline.

### Benchmark methodology

- Added a **file-level Okapi BM25 baseline** (`--strategy bm25`, k1=1.5, b=0.75) so
  retrieval is graded against a real lexical baseline, not just binary keyword presence.
- Added **Hits@1 / Hits@5** metrics — the meaningful metrics when a task has a single
  gold file.
- Removed the fabricated `T01` dataset task (an "authentication / 401 / login flow"
  query with no corresponding code in this repository).
- Unified E2E token accounting to use `DeterministicTokenEstimator` on both sides of the
  savings comparison (was `words × 1.3` vs the estimator).

### Continuous integration

- Added `.github/workflows/ci.yml`: a blocking **build + lint + test** job on every push
  and PR, plus a **non-blocking** acceptance-benchmark job that runs the offline
  deterministic retrieval gate (`evaluate.ts` + `e2e-benchmark.ts` + `check-acceptance.ts`)
  and uploads the JSON as an artifact.
- **Honest gate status:** the retrieval *ranking* gate passes (structural still beats
  keyword on R@10/NDCG@10/MRR after RRF). The E2E *focused-retrieval* thresholds
  (recall ≥ 0.95, precision ≥ 0.35) currently fail (~0.77 recall) — these thresholds were
  reverse-engineered from the OLD system while the hardcoded query-expansion contamination
  was still inflating in-repo recall. Removing the contamination exposed the real number.
  The E2E job is therefore non-blocking until the thresholds are re-derived on a calibration
  split with commit-derived ground truth (WS0.1/WS0.6). Thresholds were **not** lowered to
  force a pass.

### Bug fixes

- The embedded web inspector no longer crashes the MCP server process on `EADDRINUSE`;
  it logs and disables itself instead (`src/web/server.ts`).
- `ingest_context.type` is now a JSON-Schema enum instead of free-form text.
- Intent detection uses word-boundary matching only — dropped substring false positives
  (e.g. "show" matching "how", "prefix" matching "fix").

### Docs

- Added `IMPLEMENTATION-PLAN.md` — phased roadmap with execution status.
- `benchmarks/RESULTS.md` flagged: existing numbers pre-date the contamination removal
  and BM25 baseline and must be regenerated.

### Known follow-ups (next)

- Re-tune `getAdaptiveStrategy` and the acceptance gate against the *fixed* benchmark with
  the code embedding model (requires the multi-GB model download — not done in CI).
- Update the acceptance gate to compare against the BM25 baseline rather than the weak
  keyword baseline.
