# Spacefolding — Claude Code Integration

> **Fold infinite context space into what fits in your prompt window.**

Spacefolding is an MCP server that manages context for coding agents. It scores, routes, and compresses context into three tiers: hot (verbatim), warm (compressed), cold (archived).

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

| Tool | What it does |
|------|-------------|
| `ingest_context` | Add context (text, code, diffs, logs, constraints) |
| `score_context` | Score + route chunks into hot/warm/cold |
| `compress_context` | Compress chunks into structured summary |
| `get_relevant_memory` | Search archived context by relevance |
| `update_context_graph` | Add/remove dependency links |
| `explain_routing` | Show why each chunk was routed to its tier |

## Recommended Flow

```
1. ingest_context for each source (conversation, files, diffs, logs)
2. score_context against the current task
3. Use hot chunks verbatim, warm as summaries, cold for on-demand retrieval
4. get_relevant_memory when you need something from cold storage
```

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
