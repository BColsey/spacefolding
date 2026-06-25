# Spacefolding — Claude Code Integration

> **The local-first context-engineering engine for coding agents.**

Spacefolding is an MCP server that manages context for coding agents. It ingests, scores, routes, and compresses context into three tiers: hot (verbatim), warm (compressed), cold (archived). Includes hybrid RAG retrieval (vector + FTS5 + graph) and auto-chunking for oversized files.

## Quick Setup

```json
{
  "mcpServers": {
    "spacefolding": {
      "command": "node",
      "args": ["/path/to/spacefolding/dist/main.js", "serve"],
      "env": {
        "DB_PATH": "/path/to/spacefolding/data/spacefolding.db",
        "MODEL_PATH": "/path/to/spacefolding/data/models"
      }
    }
  }
}
```

First-time: run `node dist/main.js download-model` to get the embedding model.

📖 **Full integration guide:** [docs/integration-guide.md](docs/integration-guide.md)
⚙️ **Configuration:** [docs/configuration.md](docs/configuration.md)

## Tool Summary

Spacefolding advertises **4 canonical tools** (token-efficient surface). All 12 legacy tool names (`ingest_context`, `ingest_project`, `score_context`, `explain_routing`, etc.) remain callable as aliases via `CallTool` for backward compatibility — each keeps its own handler and original output shape, they are just not advertised in `ListTools`.

| Tool | What it does |
|------|-------------|
| `get_context_for_task` | **One-call default.** Ensures the index is populated (ingests `rootPath` if empty + allowed), then retrieves + packs task context into the token budget |
| `retrieve_context` | **Hybrid RAG retrieval** — vector + FTS5 + graph, with token budget. Optional `explain` / `score` flags fold routing explanation and hot/warm/cold scoring into the response |
| `ingest` | **Unified ingest** — `mode: auto \| item \| project \| directory`. Item ingests one content string; project/directory index a path tree (confined to `SF_INGEST_ROOTS`) |
| `get_relevant_memory` | Search warm/cold archived context by relevance |

## Recommended Flow

```
1. get_context_for_task(task, rootPath?)  # one-call default; auto-ingests if index empty, then retrieves+packs
2. retrieve_context(query, ...)            # explicit hybrid RAG with token budget (add explain=true / score=true to fold routing in)
3. ingest(...)                             # explicit ingest: item content, or project/directory path
4. get_relevant_memory                     # when you need something from cold/warm storage
```

Alias migration cheatsheet: `ingest_context`/`ingest_project`/`ingest_directory` → `ingest` (item/project/directory); `score_context` → `retrieve_context` with `score: true`; `explain_routing` → `retrieve_context` with `explain: true`; `compress_context`, `iterative_retrieve`, `update_context_graph`, `list_context`, `delete_context` keep their dedicated behavior (call by legacy name).

## Context Types

| Type | Use for | Routing boost |
|------|---------|--------------|
| `constraint` | "Must do X", "Never do Y" | Promoted to hot |
| `instruction` | "Fix X", "Implement Y" | Promoted to hot |
| `code` | Source code | Semantic relevance |
| `diff` | Git diffs | Relevance + recency |
| `log` | Error output | Boosted for debug tasks |
| `fact` | General info | Normal |
| `background` | Project context | Demoted if stale |
| `summary` | Prior summaries | Redundancy-checked |
| `reference` | API docs | Normal |
