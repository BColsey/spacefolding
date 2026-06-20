---
title: Retrieval Pipeline
description: Explanation of Spacefolding query planning, retrieval strategies, selection modes, and token budgets.
last_updated: 2026-05-27
review_schedule: quarterly
owner: maintainers
doc_type: explanation
---

# Retrieval Pipeline

The retrieval pipeline turns a task-shaped query into a compact context bundle. It combines code-aware signals with token-budget selection.

## Pipeline

```mermaid
flowchart LR
  query[Query] --> plan[Intent and complexity planning]
  plan --> strategy[Choose strategy]
  strategy --> candidates[Retrieve candidates]
  candidates --> rank[Score and merge sources]
  rank --> select[Focused/broad/exhaustive selection]
  select --> budget[Budget fill]
  budget --> result[Chunks plus retrieval metadata]
```

## Query Planning

The planner detects intent and scope:

| Intent | Example query | Default budget ratio |
| --- | --- | ---: |
| `debug` | `fix the auth error` | 0.60 |
| `implement` | `add rate limiting` | 0.40 |
| `explain` | `how does routing work` | 0.30 |
| `code_search` | `where is ContextRouter` | 0.35 |
| `general` | `authentication context` | 0.50 |

Narrow queries receive a smaller effective budget. Broad queries receive a larger one. File paths, identifiers, and quoted terms also feed structural retrieval.

## Retrieval Strategies

| Strategy | What it uses | Best for |
| --- | --- | --- |
| `structural` | Paths, symbols, references, FTS, vector signals | Default codebase retrieval when symbols are indexed; the calibrated hybrid under a GPU code model |
| `hybrid` | Vector search plus FTS5 | Local embeddings that benefit from keyword support |
| `vector` | Embedding similarity | Embedding-only retrieval / debugging |
| `text` | FTS5 and lexical search | Deterministic embeddings or keyword-heavy tasks |
| `graph` | Dependency links | Explicit relationship traversal |

Adaptive strategy selection depends on `EMBEDDING_PROVIDER`:

| Provider | Adaptive strategy |
| --- | --- |
| `gpu` | `structural` |
| `local` | `hybrid` |
| `deterministic` | `text` |

For `gpu` (a real code-embedding model), the calibrated `structural` hybrid is
competitive with the strongest lexical baselines on recall and beats FTS on top-1;
vector-only is strictly dominated by it on the commit-derived benchmark (no
universal winner — a correct path-aware BM25F leads top-1 on django/rust). See
[`benchmarks/FROZEN-CLAIM.md`](../../benchmarks/FROZEN-CLAIM.md).

When code symbols are indexed, CLI and MCP retrieval can use `structural` for code-aware matching.

## Selection Modes

| Mode | Target budgets by complexity | Selection behavior |
| --- | --- | --- |
| `focused` | 6k narrow, 13k moderate, 18k broad | Keeps high-confidence context with score thresholds and per-file caps. |
| `broad` | 16k narrow, 28k moderate, 40k broad | Widens coverage for ambiguous tasks. |
| `exhaustive` | Caller hard budget | Preserves raw breadth for manual inspection and ranking benchmarks. |

The hard budget still wins. If `maxTokens` is lower than the target budget, Spacefolding uses the lower hard limit.

## Example

```bash
node dist/main.js retrieve \
  --query "where does retrieve_context decide focused mode budgets" \
  --strategy structural \
  --mode focused \
  --max-tokens 50000
```

Expected output includes query intent, strategy, mode, target budget, hard budget, selected chunks, retrieval sources, and dropped-candidate counts.

## See Also

- [CLI reference](../reference/cli.md#retrieve)
- [MCP tools reference](../reference/mcp-tools.md#retrieve_context)
- [Run benchmarks](../howto/run-benchmarks.md)
