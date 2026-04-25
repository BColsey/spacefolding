# Benchmark Results — Spacefolding Retrieval Evaluation

**Date:** 2026-04-20 (updated with real embeddings)
**Codebase:** Spacefolding itself (34 source files, 44 chunks)
**Tasks:** 20 (5 debug, 7 explain, 5 implement, 3 code_search)
**Dataset:** `benchmarks/dataset.json`

> **See also:** [Ablation Study (Deterministic)](ABLATION.md) | [Ablation Study (Real Embeddings)](ABLATION-REAL-EMBEDDINGS.md)

## Summary

| Metric | Spacefolding | Keyword | Path-Match | Random |
|--------|:-----------:|:-------:|:----------:|:------:|
| **Recall@5** | 0.087 | **0.704** | 0.408 | 0.075 |
| **Recall@10** | 0.379 | **0.787** | 0.421 | 0.346 |
| **Recall@20** | 0.675 | **0.850** | 0.421 | 0.579 |
| **Precision@5** | 0.050 | **0.260** | 0.130 | 0.040 |
| **Precision@10** | 0.080 | **0.150** | 0.070 | 0.070 |
| **NDCG@10** | 0.185 | **0.684** | 0.353 | 0.158 |
| **MRR** | 0.196 | **0.717** | 0.367 | 0.160 |

## What This Means

**Spacefolding's hybrid retrieval loses to simple keyword search on every metric.**

### The keyword baseline crushes it

Simple keyword matching (grep-like) achieved:
- **Recall@10: 78.7%** vs Spacefolding's 37.9%
- **NDCG@10: 0.684** vs Spacefolding's 0.185
- **MRR: 0.717** vs Spacefolding's 0.196

This isn't close. Keyword search finds the right files more often and ranks them higher.

### Spacefolding barely beats random

- Recall@10: 37.9% vs random's 34.6%
- NDCG@10: 0.185 vs random's 0.158
- MRR: 0.196 vs random's 0.160

The margins are thin enough to be within noise. The deterministic hash-based embeddings Spacefolding uses are producing vectors that don't capture semantic meaning well enough to outperform random selection.

### By intent type

| Intent | Spacefolding R@10 | Keyword R@10 | Gap |
|--------|:-----------------:|:------------:|:---:|
| debug | 0.433 | 0.800 | -0.367 |
| explain | 0.381 | 0.810 | -0.429 |
| implement | 0.483 | 0.683 | -0.200 |
| code_search | 0.111 | 0.889 | -0.778 |

Spacefolding does worst on `code_search` queries (R@10 = 0.111) — the exact task you'd expect it to be good at. Keyword search excels here (R@10 = 0.889).

The `implement` intent is Spacefolding's strongest category, where it's closest to keyword (0.483 vs 0.683). This makes sense: implementation tasks benefit from semantic matching ("add rate limiting" matching to the rate-limiter code).

## Root Cause Analysis

### Why Spacefolding loses

1. **Deterministic embeddings are nearly random.** The hash-based embedding vectors don't capture semantic similarity. They're repeatable but not meaningful. Two chunks about "authentication" get unrelated vectors because the hash function doesn't understand English.

2. **FTS5 is weakened by the fusion step.** The FTS5 BM25 search actually finds good results on its own — but Reciprocal Rank Fusion dilutes them with noisy vector results. The fusion hurts more than it helps when one signal (FTS) is strong and the other (vectors) is noise.

3. **Too many results returned.** Spacefolding returns 34 results on average (the entire codebase). Keyword returns 17.6 (filtered). Precision is diluted when you return everything.

4. **No content-based scoring.** The hybrid retrieval scores by rank position only (RRF). It doesn't use the actual cosine similarity scores or BM25 scores — just relative positions. This throws away signal.

5. **Graph traversal adds noise.** Following dependency links pulls in chunks that are structurally related but irrelevant to the query. This increases recall slightly but tanks precision.

### Why keyword wins

1. **Direct lexical matching.** "Fix the authentication bug" contains "authentication" which appears in `src/core/scorer.ts` (in the constraint scoring logic). Direct match. No embedding needed.

2. **File path boosting.** The keyword baseline gives extra weight to path matches, which is extremely effective for code search. "chunker" in the query matches `src/core/chunker.ts` directly.

3. **Small codebase advantage.** With only 34 files, keyword search has high density — most terms appear in only a few files. The noise-to-signal ratio favors direct matching.

## What Would Fix This

### Quick wins (would likely flip the results)

1. **Use the real ONNX embedding model** (`EMBEDDING_PROVIDER=local`). The deterministic embeddings are the primary failure mode. Real sentence embeddings would capture semantic similarity and likely outperform keyword search on explain/implement intents.

2. **Weight FTS higher in fusion.** When vector search is weak, FTS should dominate. Add confidence-weighted fusion instead of rank-only RRF.

3. **Return fewer results.** Cap at 10 instead of 50. Precision improves dramatically when you're selective.

4. **Use raw scores, not just ranks.** Combine cosine similarity scores + BM25 scores directly, not just rank positions.

5. **Skip graph traversal by default.** It adds noise for most queries. Only use it when the initial retrieval has low confidence.

### Structural improvements

6. **Code-aware embeddings.** Fine-tune embeddings on code (e.g., CodeBERT, UniXCoder). Generic sentence embeddings don't capture code semantics.

7. **AST-based chunking.** Tree-sitter splitting would create chunks at function boundaries, which are the actual units developers search for.

8. **Hybrid score fusion.** Replace RRF with a weighted combination: `final_score = α * normalized_vector_score + β * normalized_bm25_score + γ * graph_score`.

9. **Query-time reranking.** After retrieval, use an LLM or cross-encoder to rerank the top 20 results. This is where Spacefolding's LLM compression infrastructure could help.

## Methodology Notes

- **Ground truth**: Each task has manually-identified relevant files. This is subjective — a different annotator might disagree with some labels.
- **Small codebase**: 34 files / 44 chunks is tiny. Results may differ dramatically at 10K+ files.
- **Deterministic embeddings only**: The benchmark uses hash-based embeddings, not the real ONNX model. This is the worst-case configuration.
- **No LLM compression evaluated**: This benchmark only tests retrieval accuracy, not the compression pipeline or end-to-end task completion.

## Verdict

**Spacefolding's retrieval is not yet better than keyword search.** The primary bottleneck is embedding quality. With real ONNX embeddings and tuned fusion weights, it should outperform keyword search on semantic queries (explain, implement) while matching keyword on direct searches.

The next step is to re-run this benchmark with `EMBEDDING_PROVIDER=local` and see if the gap closes.
