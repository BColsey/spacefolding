# Claude Code Integration Guide

Spacefolding is designed as an MCP (Model Context Protocol) server that Claude Code can call as a tool.

## What this enables

When connected, Claude Code can:
- **Ingest** files, diffs, and conversation context (auto-chunks if oversized)
- **Ingest projects** with source, README/docs, env examples, config, and agent instructions
- **Score** all context against the current task
- **Route** into hot (verbatim), warm (compressed), cold (archived)
- **Retrieve** context using focused RAG (structural, vector, and full-text search)
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

### `ingest_project`

Ingest a project using source files plus high-value project context. This is the preferred first step for a codebase because it keeps README/docs, `.env.example`, config files, and agent instruction files retrievable alongside source code while skipping tests and benchmarks by default.

```json
{
  "path": "/path/to/project",
  "includeDocs": true,
  "includeTests": false,
  "includeBenchmarks": false
}
```

**Parameters:**
- `path` (required) — Absolute project directory path
- `includeDocs` — Include README files and `docs/**/*.md` (default: `true`)
- `includeTests` — Include test/spec files and test directories (default: `false`)
- `includeBenchmarks` — Include benchmark directories (default: `false`)

Agent instruction files such as `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, and `.cursor/rules/**` are split by markdown heading and classified as `constraint` or `instruction` chunks.

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

Focused RAG retrieval with token budget control. When code symbols are indexed, it defaults to structural retrieval over paths, symbols, imports/references, and lexical matches. It can also use hybrid, vector, text, or graph strategies.

```json
{
  "query": "How does JWT authentication work?",
  "maxTokens": 50000,
  "strategy": "structural",
  "mode": "focused",
  "topK": 15,
  "returnLimit": 15,
  "maxHops": 0
}
```

**Parameters:**
- `query` (required) — What you're looking for
- `maxTokens` — Max token budget (default: auto based on query intent)
- `strategy` — `structural`, `hybrid`, `vector`, `text`, or `graph`
- `mode` — `focused` (default), `broad`, or `exhaustive`
- `topK` — Max retrieval results before selection (default: adaptive by query)
- `returnLimit` — Max scored candidates to consider before budget filling
- `maxHops` — Max dependency graph hops (default: auto based on intent)

Use `focused` for normal coding-agent prompts. Use `broad` when the task is ambiguous and you want more coverage. Use `exhaustive` for manual inspection or ranking benchmarks where you want the raw breadth up to `maxTokens`.

**Returns:**
```json
{
  "chunks": [{
    "id": "...",
    "text": "...",
    "path": "src/auth/login.ts",
    "tokensEstimate": 900,
    "tier": "warm",
    "retrievalSources": ["structural", "fts"],
    "retrievalScores": { "structural": 12.5, "fts": 0.4, "final": 12.9 },
    "retrievalReasons": ["symbol exact match: authenticate"]
  }],
  "totalTokens": 14800,
  "budget": 50000,
  "hardBudget": 50000,
  "targetBudget": 13000,
  "utilization": 0.296,
  "omittedCount": 3,
  "compressedCount": 0,
  "compressedSummaries": [],
  "selectionPolicy": { "mode": "focused", "selectedCandidates": 9 },
  "plan": { "intent": "explain", "strategy": "structural" }
}
```

## Recommended Workflow

```
1. Before starting a task:

   ingest_project(path=<project root>)
   ingest_context(source="conversation", text=<user request>, type="instruction")
   ingest_context(source="conversation", text=<constraints>, type="constraint")

2. Score and route:

   score_context(task={text: "What the user asked"})
   
3. Use hot chunks in your prompt, compress warm if needed
4. During work, retrieve focused context when you need something:

   retrieve_context(query=<task-specific need>, mode="focused")
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
