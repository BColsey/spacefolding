---
title: How Spacefolding Works
description: Explanation of Spacefolding's context lifecycle, routing tiers, scoring, and storage model.
last_updated: 2026-05-27
review_schedule: quarterly
owner: maintainers
doc_type: explanation
---

# How Spacefolding Works

Spacefolding is a local context service for coding agents. It keeps important context exact, summarizes useful context, and archives everything else so it can be retrieved later.

## Context Lifecycle

```mermaid
flowchart TB
  start[Project files, docs, chat, diffs, logs]
  chunk[Chunk by code, Markdown, or text boundaries]
  classify[Classify as code, constraint, instruction, log, diff, reference, or background]
  embed[Create embeddings and structural indexes]
  score[Score against the active task]
  route[Route into hot, warm, or cold tiers]
  prompt[Return prompt-ready context]
  store[(SQLite, embeddings, FTS5, symbols, dependency graph)]

  start --> chunk --> classify --> embed --> score --> route
  route --> prompt
  route --> store
  store --> score
```

The database remains the source of truth. Vector indexes and retrieval caches can be rebuilt from stored chunks and embeddings.

## Routing Tiers

| Tier | What is stored | Why it exists |
| --- | --- | --- |
| Hot | Full text | Preserve exact constraints, active source, and must-use facts. |
| Warm | Compressed summary with source chunk IDs | Keep useful context compact while preserving provenance. |
| Cold | Indexed archive | Avoid prompt bloat while keeping old material searchable. |

Hot context is intentionally scarce. Warm context keeps signal without paying the full token cost. Cold context is not discarded; it is searched through retrieval when the task needs it.

## Scoring Model

Every chunk receives a composite score for the current task:

| Factor | Default weight | Meaning |
| --- | ---: | --- |
| Semantic similarity | 0.30 | Does this chunk match the task meaning? |
| Constraint priority | 0.25 | Is this a hard requirement or instruction? |
| Recency | 0.20 | Was this context produced recently? |
| Redundancy | 0.10 | Is this repeating other context? |
| Dependencies | 0.15 | Does another important chunk depend on this one? |

The router compares the score with hot and warm thresholds. Dependency links can pull related chunks upward when they are needed to understand a hot chunk.

## Chunking

```mermaid
flowchart LR
  file[Oversized file] --> detect{Content type}
  detect --> code[Code splitter]
  detect --> md[Markdown splitter]
  detect --> text[Recursive text splitter]
  code --> chunks[Child chunks with overlap]
  md --> chunks
  text --> chunks
  chunks --> links[Parent-child and dependency links]
```

The splitter uses code, Markdown, or recursive text boundaries. Overlap reduces information loss at chunk edges, and child chunks are scored independently.

## Local-First Design

Spacefolding runs as a local process or Docker container. It can use cloud-compatible LLM APIs for warm-context compression, but the default setup uses local embeddings and deterministic compression.

| Component | Default behavior |
| --- | --- |
| Database | SQLite under `./data/spacefolding.db` |
| Embeddings | Local ONNX model, cached under `./data/models` |
| Compression | Deterministic summary extraction |
| Transport | MCP over stdio |
| Web UI | Disabled until `WEB_PORT` is set |

## See Also

- [Retrieval pipeline](./retrieval-pipeline.md)
- [Architecture reference](../reference/architecture.md)
- [Configuration reference](../configuration.md)
