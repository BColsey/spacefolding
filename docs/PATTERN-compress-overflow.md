# Budget-Aware Compressive Overflow

> Named pattern for context management in LLM coding agents.

## The Problem

LLM coding agents have a fixed token budget for context. When retrieving relevant code files, the retrieval system often finds more relevant files than can fit in the budget. The traditional approaches are:

1. **Truncation**: Drop files that don't fit → loses information
2. **Full compression**: Compress everything → loses granularity of high-priority files
3. **Cherry-picking**: Only return the top-K → misses diverse but relevant results

## The Pattern: Budget-Aware Compressive Overflow

```
1. Retrieve N chunks ranked by relevance
2. Fill budget with best-fitting chunks (knapsack)
   → Return these VERBATIM as tier='hot' or 'warm'
3. For chunks that don't fit:
   → Compress into summaries (~5-10% of original size)
   → Add summaries as tier='compressed'
4. Return: verbatim chunks + compressed summaries
```

The key insight: **high-relevance chunks are preserved verbatim, while overflow chunks are compressed rather than dropped.**

## Implementation in Spacefolding

The pattern is implemented in two files:

### `src/core/budget.ts` — `fillBudget()` + `compressOmitted()`

1. `fillBudget()` runs a greedy knapsack: sorts by relevance, fills budget with best-fitting chunks, tracks omitted chunks with reasons
2. `compressOmitted()` takes the omitted list, estimates compressed size (10% of original), calls the compression provider for each, adds summaries as synthetic chunks with `tier='compressed'`

### `src/pipeline/orchestrator.ts` — `retrieve()`

After budget fill, calls `compressOmitted()` with the configured compression provider (deterministic, local, or LLM). Capped at 5 compressed summaries to bound latency.

## Properties

| Property | Value |
|----------|-------|
| Information preservation | Higher than truncation — overflow files still represented as summaries |
| Verbatim fidelity | High-priority chunks untouched |
| Latency overhead | O(5) compression calls (capped) |
| Budget utilization | Higher — compressed summaries fill gaps that would be wasted |
| Backwards compatible | LLM can request full text via `compressedFrom` ID |

## Comparison to Alternatives

| Approach | High-priority chunks | Overflow chunks | Budget utilization |
|----------|---------------------|-----------------|-------------------|
| **Truncation** | Verbatim | Dropped | Wasted tail |
| **Full compression** | Compressed | Compressed | Full but lossy |
| **Budget-Aware Compressive Overflow** | Verbatim | Summarized | Full, tiered fidelity |

## When to Use

- When context windows are limited relative to the codebase
- When some files are much larger than others (asymmetric compression benefit)
- When the retrieval system returns more relevant results than can fit

## When NOT to Use

- When the compression provider is slow (LLM API calls) and latency matters — cap `maxCompress` to 0 or 1
- When all chunks fit in the budget (no overflow = no compression needed)
- When the chunks are already very small (compression ratio is negligible)

## Academic Context

This pattern combines:
- **Greedy knapsack** for budget filling (well-established)
- **Query-focused summarization** for overflow compression (see: LLMLingua, 2023)
- **Tiered fidelity** — a novel combination not found as a named pattern in the literature

Closest related work:
- **GenericAgent** (Fudan, 2026) — "Contextual Information Density Maximization" with hierarchical memory
- **Mem0** (2025) — Tiered memory architecture with graph-based retrieval
- **LLMLingua** (2023) — Token-level compression, but compresses everything uniformly
