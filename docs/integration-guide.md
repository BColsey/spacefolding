# Claude Code Integration Guide

Spacefolding is designed as an MCP (Model Context Protocol) server that Claude Code can call as a tool.

## What this enables

When connected, Claude Code can:
- **Ingest** files, diffs, and conversation context (auto-chunks if oversized)
- **Score** all context against the current task
- **Route** into hot (verbatim), warm (compressed), cold (archived)
- **Retrieve** context using hybrid RAG (vector + full-text + graph search)
- **Compress** warm context using LLM or deterministic providers
- **Explain** why routing decisions were made

## Setup

### Option 1: Local Node.js

Add to `.claude/settings.json` or `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "spacefolding": {
      "command": "node",
      "args": ["/path/to/spacefolding/dist/main.js", "serve"],
      "env": {
        "DB_PATH": "/path/to/spacefolding/data/spacefolding.db",
        "MODEL_PATH": "/path/to/spacefolding/data/models",
        "EMBEDDING_MODEL": "Xenova/all-MiniLM-L6-v2",
        "WEB_PORT": "8080"
      }
    }
  }
}
```

### Option 2: Docker

```json
{
  "mcpServers": {
    "spacefolding": {
      "command": "docker",
      "args": [
        "compose", "-f", "/path/to/spacefolding/docker-compose.yml",
        "exec", "-T", "spacefolding", "node", "dist/main.js", "serve"
      ]
    }
  }
}
```

### First-time setup

Download the embedding model before first use:

```bash
# Local:
node dist/main.js download-model

# Docker:
docker compose run --rm spacefolding node dist/main.js download-model
```

## Tool Reference

### `ingest_context`

Add context to the store.

```json
{
  "source": "conversation",
  "text": "Must use JWT for all endpoints",
  "type": "constraint"
}
```

**Parameters:**
- `source` (required) — Where this came from: `conversation`, `file`, `diff`, `log`, `summary`
- `text` (required) — The content
- `type` — Override the auto-detected type
- `path` — File path if from a file
- `language` — Programming language if code

### `score_context`

Score all chunks against a task and get routing.

```json
{
  "task": { "text": "Fix the auth bug in login.ts" },
  "chunkIds": ["optional-filter-to-specific-ids"],
  "maxTokens": 50000
}
```

**Returns:** `{ hot: [], warm: [], cold: [], scores: {}, reasons: {} }`

### `compress_context`

Compress specific chunks into a summary.

```json
{
  "task": { "text": "Fix auth bug" },
  "chunkIds": ["chunk-id-1", "chunk-id-2"]
}
```

**Returns:** `{ summary: "...", retainedFacts: [], retainedConstraints: [], sourceChunkIds: [] }`

### `get_relevant_memory`

Search cold/warm storage for relevant context.

```json
{
  "task": { "text": "How does JWT validation work?" },
  "filters": { "type": "code", "path": "src/auth" }
}
```

**Returns:** `{ chunks: [], explanations: [] }`

### `update_context_graph`

Add or remove dependency links.

```json
{
  "chunkId": "primary-id",
  "operation": "add",
  "dependencies": [
    { "fromId": "a", "toId": "b", "type": "references", "weight": 0.7 }
  ]
}
```

### `explain_routing`

Show why chunks were routed the way they were.

```json
{
  "task": { "text": "Fix auth bug" },
  "chunkId": "optional-specific-chunk"
}
```

### `retrieve_context`

Hybrid RAG retrieval with token budget control. Runs vector search + FTS5 + graph traversal, fuses results, and returns chunks that fit within a token budget.

```json
{
  "query": "How does JWT authentication work?",
  "maxTokens": 50000,
  "strategy": "hybrid",
  "topK": 50,
  "maxHops": 2
}
```

**Parameters:**
- `query` (required) — What you're looking for
- `maxTokens` — Max token budget (default: auto based on query intent)
- `strategy` — `hybrid`, `vector`, `text`, or `graph`
- `topK` — Max results to consider (default: 50)
- `maxHops` — Max dependency graph hops (default: auto based on intent)

**Returns:**
```json
{
  "chunks": [{ "id": "...", "text": "...", "tier": "warm", "retrievalSources": ["vector", "fts"] }],
  "totalTokens": 48500,
  "budget": 50000,
  "utilization": 0.97,
  "omittedCount": 3,
  "plan": { "intent": "explain", "strategy": "vector" }
}
```

## Recommended Workflow

```
1. Before starting a task:

   ingest_context(source="conversation", text=<user request>, type="instruction")
   ingest_context(source="file", text=<relevant files>, path="...")
   ingest_context(source="conversation", text=<constraints>, type="constraint")

2. Score and route:

   score_context(task={text: "What the user asked"})
   
3. Use hot chunks in your prompt, compress warm if needed
4. During work, retrieve from cold when you need something
```

## Context Types

| Type | When to use | Routing behavior |
|------|------------|-----------------|
| `constraint` | Hard requirements, "must do X" | Promoted to hot if score > 0.3 |
| `instruction` | Action items, "fix X" | Promoted to hot if score > 0.5 |
| `code` | Source code | Scored by semantic relevance |
| `diff` | Git diffs | Scored by relevance + recency |
| `log` | Error logs, output | Boosted if task mentions debugging |
| `fact` | General information | Normal scoring |
| `background` | Project context | Demoted if stale |
| `summary` | Prior summaries | Checked for redundancy |
| `reference` | Documentation | Normal scoring |
