# Spacefolding — Claude Code Integration

This file describes how to use Spacefolding's MCP tools from Claude Code.

## What is Spacefolding?

Spacefolding is an intelligent context compression and routing service. It acts as a middle layer between you (the user) and the LLM context window — deciding what context goes in verbatim (hot), what gets compressed (warm), and what gets archived but remains retrievable (cold).

Think of it as **folding infinite context space into the finite window of a prompt**.

## MCP Server Configuration

### Option 1: Local Node.js

Add to your Claude Code settings (`.claude/settings.json`):

```json
{
  "mcpServers": {
    "spacefolding": {
      "command": "node",
      "args": ["/path/to/spacefolding/dist/main.js", "serve"],
      "env": {
        "DB_PATH": "/path/to/spacefolding/data/spacefolding.db",
        "MODEL_PATH": "/path/to/spacefolding/data/models",
        "EMBEDDING_MODEL": "Xenova/all-MiniLM-L6-v2"
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
        "run", "--rm", "-i",
        "-v", "/path/to/data:/app/data",
        "-v", "/path/to/workspace:/workspace:ro",
        "spacefolding",
        "serve"
      ]
    }
  }
}
```

### First-Time Setup

Before first use, download the embedding model:

```bash
# Local:
node dist/main.js download-model

# Docker:
docker compose run --rm spacefolding node dist/main.js download-model
```

This downloads `Xenova/all-MiniLM-L6-v2` (~80MB) to `./data/models/`. Only needed once — the model persists in the Docker volume.

## Tool Usage Guide

### Workflow

```
Before starting work on a task:

1. INGEST all relevant context:
   ingest_context(source, text, type)  →  for each source

2. SCORE the context against your task:
   score_context(task)  →  get hot/warm/cold routing

3. USE the results:
   - HOT chunks → include verbatim in your prompt
   - WARM chunks → use compressed summaries
   - COLD chunks → available via get_relevant_memory when needed

4. DURING work, retrieve from cold storage:
   get_relevant_memory(task, filters)  →  find archived context
```

### Example Workflow

```
User: "Fix the authentication bug in login.ts"

Step 1 — Ingest context:
  ingest_context(source="conversation", text="Fix the authentication bug", type="instruction")
  ingest_context(source="file", text=<contents of login.ts>, path="src/auth/login.ts")
  ingest_context(source="log", text="ERROR 401 Unauthorized at /api/login")
  ingest_context(source="conversation", text="Must use JWT for auth", type="constraint")

Step 2 — Score and route:
  score_context(task={text: "Fix authentication bug in login.ts"})
  → Returns: hot=[constraint, code], warm=[log], cold=[]

Step 3 — Use results:
  Include hot chunks directly in context
  Compress warm chunks if token budget is tight

Step 4 — Retrieve from cold during work:
  get_relevant_memory(task={text: "How does JWT validation work?"})
  → Retrieves relevant chunks from cold/warm storage
```

### When to Call Each Tool

| Tool | When to call |
|------|-------------|
| `ingest_context` | Before starting work, when receiving new information |
| `score_context` | When deciding what to include in the next LLM call |
| `compress_context` | When token budget requires condensing warm context |
| `get_relevant_memory` | When you need to look up information you previously excluded |
| `update_context_graph` | When you discover relationships between chunks |
| `explain_routing` | When debugging why context was included or excluded |

### Context Types

When ingesting, choose the appropriate type for better routing:

| Type | Use for |
|------|---------|
| `constraint` | Hard requirements, "must do X", "never do Y" |
| `instruction` | Action items, "fix X", "implement Y" |
| `code` | Source code from files |
| `diff` | Git diffs |
| `log` | Error logs, output, stack traces |
| `fact` | General information, notes |
| `background` | Project context, descriptions |
| `summary` | Prior conversation summaries |
| `reference` | Documentation, API docs |

### Best Practices

1. **Ingest early** — Add all relevant context before scoring
2. **Mark constraints** — Always use `type="constraint"` for hard requirements (they get promoted to hot)
3. **Score regularly** — Re-score when the task evolves
4. **Include paths** — Always include `path` when ingesting code for better dependency analysis
5. **Check cold storage** — Use `get_relevant_memory` before assuming something is missing
6. **Explain decisions** — Use `explain_routing` to debug why context was excluded
