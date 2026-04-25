# Ablation Study Results

**Date:** 2026-04-20
**Codebase:** Spacefolding (34 files, 44 chunks)
**Tasks:** 20 (5 debug, 7 explain, 5 implement, 3 code_search)

## The Numbers

| Strategy | R@5 | R@10 | R@20 | P@10 | NDCG@10 | MRR | Results |
|----------|:---:|:----:|:----:|:----:|:-------:|:---:|:-------:|
| **keyword** | **0.704** | **0.787** | **0.850** | **0.260** | **0.684** | **0.717** | 17.6 |
| fts-only | 0.500 | 0.633 | 0.767 | 0.180 | 0.485 | 0.466 | 15.6 |
| fts-top10 | 0.500 | 0.583 | 0.583 | 0.180 | 0.464 | 0.463 | 7.6 |
| vector-only | 0.054 | 0.362 | 0.700 | 0.075 | 0.181 | 0.197 | 34.0 |
| fts-vector-rrf | 0.438 | 0.642 | **0.850** | 0.150 | 0.455 | 0.467 | 34.0 |
| full-pipeline | 0.454 | 0.604 | **0.850** | 0.160 | 0.366 | 0.332 | 34.0 |

## Recall@10 by Intent

| Intent | keyword | fts-only | fts-top10 | vector-only | fts-vector-rrf | full-pipeline |
|--------|:-------:|:--------:|:---------:|:-----------:|:--------------:|:-------------:|
| debug | 0.800 | 0.433 | 0.367 | 0.433 | **0.600** | **0.600** |
| explain | **0.810** | 0.643 | 0.643 | 0.381 | 0.643 | 0.643 |
| implement | 0.683 | **0.700** | 0.633 | 0.417 | 0.567 | 0.517 |
| code_search | **0.889** | 0.833 | 0.722 | 0.111 | 0.833 | 0.667 |

## Key Findings

### 1. FTS5 was broken — now fixed

Phase 1 showed FTS5 returning zero results. Root cause: `searchByText()` passed raw natural language queries to FTS5's MATCH operator, which interpreted "How does the scoring engine..." as boolean syntax and threw errors caught silently by the catch block. **Fixed by tokenizing the query, filtering stop words, and building a safe OR query.**

Impact: Before fix, full pipeline R@10 = 0.379 (vector-only since FTS contributed nothing). After fix, full pipeline R@10 = 0.604 — a 59% improvement from fixing one function.

### 2. FTS5 alone is competitive with keyword search

| Metric | keyword | fts-only | Gap |
|--------|:-------:|:--------:|:---:|
| R@10 | 0.787 | 0.633 | -0.154 |
| NDCG@10 | 0.684 | 0.485 | -0.199 |
| MRR | 0.717 | 0.466 | -0.251 |

FTS5 captures 80% of keyword search's recall at 10. The keyword baseline's edge comes from:
- Path boosting (searching file paths, not just content)
- Better tokenization (length > 3 filter is more aggressive)

### 3. FTS5 alone BEATS keyword on implement tasks

FTS5-only R@10 for `implement` = **0.700** vs keyword's **0.683**. This is the first time any Spacefolding component has beaten keyword at anything. Implementation queries use natural language ("Add support for local embedding models") where FTS5's BM25 ranking finds the right terms.

### 4. Vector search is still nearly useless with deterministic embeddings

Vector-only R@10 = 0.362, barely above random (0.346 from Phase 1). The deterministic hash embeddings are noise. **This validates the hypothesis: real embeddings are the #1 priority.**

### 5. Fusion helps recall but hurts ranking quality

| Metric | fts-only | fts-vector-rrf | Change |
|--------|:--------:|:--------------:|:------:|
| R@10 | 0.633 | 0.642 | +0.009 |
| R@20 | 0.767 | 0.850 | +0.083 |
| NDCG@10 | 0.485 | 0.455 | -0.030 |
| MRR | 0.466 | 0.467 | +0.001 |

Fusion with garbage vectors slightly increases R@20 (pulling in extra chunks) but doesn't help ranking quality. The vector signal is too weak to improve top-10 ordering.

### 6. Full pipeline is WORSE than FTS+vector fusion

| Metric | fts-vector-rrf | full-pipeline | Change |
|--------|:--------------:|:-------------:|:------:|
| R@10 | 0.642 | 0.604 | **-0.038** |
| NDCG@10 | 0.455 | 0.366 | **-0.089** |
| MRR | 0.467 | 0.332 | **-0.135** |

Graph traversal **hurts**. Adding dependency-graph links dilutes the ranking. On debug tasks, full pipeline matches fts-vector-rrf (0.600), but on code_search it tanks: 0.833 → 0.667. Graph traversal pulls in structurally-related but query-irrelevant files.

### 7. Capping at 10 results reduces recall without improving ranking

| Metric | fts-only | fts-top10 | Change |
|--------|:--------:|:---------:|:------:|
| R@10 | 0.633 | 0.583 | -0.050 |
| NDCG@10 | 0.485 | 0.464 | -0.021 |

Capping at 10 loses recall but doesn't meaningfully improve ranking quality. The BM25 ranking is already doing a decent job ordering results.

## Conclusions

1. **The FTS5 bug fix was the single biggest win** — from 0.379 to 0.604 R@10 for the full pipeline.
2. **FTS5 is the backbone** — it provides 80% of the retrieval quality on its own.
3. **Vector search with deterministic embeddings adds nothing useful** — sometimes slightly helps recall, sometimes hurts ranking.
4. **Graph traversal hurts more than it helps** — should be disabled by default or only activated conditionally.
5. **Keyword still wins overall** — but the gap narrowed from 2x (Phase 1) to 1.3x (this ablation).

## What Would Close the Gap

1. **Real ONNX embeddings** — the #1 improvement. Would make vector search actually useful, which would make fusion work as designed.
2. **FTS5 + keyword path boosting** — combine FTS5's BM25 with keyword's path-matching. This alone might match or beat keyword.
3. **Conditional graph traversal** — only activate when FTS+vector confidence is low.
4. **Weighted fusion** — give FTS higher weight than vectors when using deterministic embeddings.
5. **Result cap at 15-20** — not 10 (loses recall) and not 50 (dilutes precision).
