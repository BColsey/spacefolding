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

### Benchmark methodology

- Added a **file-level Okapi BM25 baseline** (`--strategy bm25`, k1=1.5, b=0.75) so
  retrieval is graded against a real lexical baseline, not just binary keyword presence.
- Added **Hits@1 / Hits@5** metrics — the meaningful metrics when a task has a single
  gold file.
- Removed the fabricated `T01` dataset task (an "authentication / 401 / login flow"
  query with no corresponding code in this repository).
- Unified E2E token accounting to use `DeterministicTokenEstimator` on both sides of the
  savings comparison (was `words × 1.3` vs the estimator).

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

- Weighted Reciprocal Rank Fusion to replace min-max score fusion — now unblocked by the
  BM25 + Hits benchmark that can validate it.
- Swap the default embedding model to a code-specific model (e.g. SFR-Embedding-Code).
- Update the acceptance gate to compare against the BM25 baseline rather than the weak
  keyword baseline.
