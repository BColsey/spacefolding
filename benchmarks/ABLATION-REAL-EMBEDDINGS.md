# Ablation Study Results — WITH REAL EMBEDDINGS

**Date:** 2026-04-20
**Codebase:** Spacefolding (34 files, 44 chunks)
**Tasks:** 20 (5 debug, 7 explain, 5 implement, 3 code_search)
**Embeddings:** `Xenova/all-MiniLM-L6-v2` (ONNX, 384-dim, real sentence-transformer)
**Previous run:** Deterministic hash-based embeddings (near-random vectors)

## The Numbers (Real Embeddings)

| Strategy | R@5 | R@10 | R@20 | P@10 | NDCG@10 | MRR | Results |
|----------|:---:|:----:|:----:|:----:|:-------:|:---:|:-------:|
| **keyword** | **0.704** | **0.787** | 0.850 | **0.260** | **0.684** | **0.717** | 17.6 |
| fts-only | 0.500 | 0.633 | 0.767 | 0.180 | 0.485 | 0.466 | 15.6 |
| fts-top10 | 0.500 | 0.583 | 0.583 | 0.180 | 0.464 | 0.463 | 7.6 |
| vector-only | 0.563 | 0.712 | **0.942** | 0.210 | 0.496 | 0.479 | 34.0 |
| fts-vector-rrf | 0.512 | 0.717 | **0.942** | 0.190 | 0.493 | 0.473 | 34.0 |
| full-pipeline | 0.479 | 0.717 | **0.942** | 0.190 | 0.435 | 0.357 | 34.0 |

## Comparison: Deterministic vs Real Embeddings

| Metric | Deterministic R@10 | Real R@10 | Change |
|--------|:------------------:|:---------:|:------:|
| vector-only | 0.362 | 0.712 | **+97%** |
| fts-vector-rrf | 0.642 | 0.717 | +12% |
| full-pipeline | 0.604 | 0.717 | **+19%** |

Real embeddings nearly **doubled** vector-only recall and pushed the full pipeline to within striking distance of keyword search.

## Recall@10 by Intent (Real Embeddings)

| Intent | keyword | fts-only | vector-only | fts-vector-rrf | full-pipeline |
|--------|:-------:|:--------:|:-----------:|:--------------:|:-------------:|
| debug | **0.800** | 0.433 | 0.700 | 0.433 | 0.433 |
| explain | 0.810 | 0.643 | 0.714 | **0.857** | **0.857** |
| implement | 0.683 | 0.700 | 0.617 | **0.733** | **0.733** |
| code_search | **0.889** | 0.833 | **0.889** | 0.833 | 0.833 |

### HYBRID BEATS KEYWORD ON 2 OF 4 INTENTS

- **explain:** fts-vector-rrf = **0.857** vs keyword 0.810 (+5.8%)
- **implement:** fts-vector-rrf = **0.733** vs keyword 0.683 (+7.3%)

Keyword still dominates debug (0.800 vs 0.433) — debug queries use specific identifiers like "token estimation" that keyword matches directly. But for semantic queries (explain, implement), the hybrid pipeline now wins.

## Key Findings

### 1. Real embeddings are transformative

Vector-only went from 0.362 → 0.712 R@10. That's the difference between "barely above random" and "competitive with keyword." The sentence-transformer model (`all-MiniLM-L6-v2`) captures actual semantic similarity in code queries.

### 2. Vector search achieves 94.2% recall@20

With real embeddings, vector search alone finds 94.2% of relevant files at 20 results. This is higher than keyword's 85% at the same cutoff. Vector search is excellent at *finding* relevant content — it just struggles with *ranking* (lower NDCG than keyword because it returns everything).

### 3. Hybrid (fts+vector) is now the best for semantic queries

The fts-vector-rrf fusion beats both FTS-only and vector-only on explain (0.857) and implement (0.733) tasks. Fusion is working as designed: FTS provides precise lexical matches, vectors provide semantic breadth, RRF combines them effectively.

### 4. Graph traversal still hurts — especially NDCG and MRR

| Metric | fts-vector-rrf | full-pipeline | Change |
|--------|:--------------:|:-------------:|:------:|
| R@10 | 0.717 | 0.717 | 0 |
| NDCG@10 | 0.493 | 0.435 | **-0.058** |
| MRR | 0.473 | 0.357 | **-0.116** |

Graph traversal adds nothing to recall but tanks ranking quality by pulling in structurally-related but irrelevant chunks. This is consistent across both embedding types. **Graph traversal should be disabled by default.**

### 5. Debug intent is the weak spot

All Spacefolding strategies struggle with debug queries (R@10 = 0.433 vs keyword's 0.800). Debug queries like "Fix the scoring calculation bug" contain abstract terms that don't match the specific implementation details. Keyword's path boosting also helps here ("scorer" → `src/core/scorer.ts`).

## Remaining Gaps vs Keyword

| Metric | keyword | best-Spacefolding | Gap |
|--------|:-------:|:-----------------:|:---:|
| R@10 | 0.787 | 0.717 | -0.070 |
| NDCG@10 | 0.684 | 0.496 | -0.188 |
| MRR | 0.717 | 0.479 | -0.238 |

The remaining gap is in **ranking quality** (NDCG, MRR), not recall. Spacefolding finds the right files but doesn't rank them as high. The top-1 and top-3 positions matter most for developer experience, and keyword is better at putting the exact right file first.

## What Would Close the Remaining Gap

1. **Remove graph traversal** — saves 0.116 MRR immediately
2. **Path boosting in vector search** — keyword's biggest advantage; add file path terms to the vector query
3. **Result capping at 10-15** — stop returning 34 results; cap and re-rank
4. **LLM reranking** — use the LLM compression infrastructure to rerank top 20 results
5. **Score-weighted fusion** — use actual cosine/BM25 scores, not just rank positions

## Methodology Notes

- Same 20 tasks as Phase 1 and ablation with deterministic embeddings
- Model: `Xenova/all-MiniLM-L6-v2` (22MB ONNX, 384-dim, downloaded via @huggingface/transformers)
- All 34 source files ingested, 44 chunks created
- Benchmark runs locally, no API calls
- keyword and fts-only results are unchanged (they don't use embeddings)
