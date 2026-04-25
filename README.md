<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-blueviolet?style=flat-square" />
  <img src="https://img.shields.io/github/issues/BColsey/spacefolding?style=flat-square&color=58a6ff" />
  <img src="https://img.shields.io/badge/Docker-ready-2496ED?style=flat-square&logo=docker&logoColor=white" />
  <img src="https://img.shields.io/badge/MCP-compatible-6E40C9?style=flat-square" />
  <img src="https://img.shields.io/badge/Status-Public-brightgreen?style=flat-square" />
</p>

<p align="center">
  <img width="600" src="https://raw.githubusercontent.com/BColsey/spacefolding/main/docs/logo.svg" alt="Spacefolding" />
</p>

<p align="center">
  <em>Fold infinite context space into what fits in your prompt window.</em>
</p>

<p align="center">
  <strong>Context compression &amp; routing for coding agents</strong><br />
  Local-first · Docker · MCP · CLI · Web UI
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#how-it-works">How It Works</a> ·
  <a href="#mcp-tools">MCP Tools</a> ·
  <a href="#cli-reference">CLI</a> ·
  <a href="docs/configuration.md">Config</a> ·
  <a href="docs/integration-guide.md">Claude Code</a>
</p>

---

```
  ╔═══════════════════════════════════════════════════════════╗
  ║                                                           ║
  ║   You have 200K tokens. Your context is 2 million.        ║
  ║                                                           ║
  ║   What goes in the window?                                ║
  ║                                                           ║
  ║   Spacefolding decides.                                   ║
  ║                                                           ║
  ╚═══════════════════════════════════════════════════════════╝
```

## What is this?

Spacefolding is a **local-first context management service** for coding agents like Claude Code.

When you're working in a codebase, context piles up fast — conversation history, source files, diffs, logs, constraints, earlier summaries. You can't fit it all into the next LLM call. Spacefolding **folds** that context space: it scores every piece, keeps what matters (hot), compresses what's useful (warm), and archives the rest (cold) — while keeping everything retrievable.

It runs as a **Docker container**, a **CLI tool**, an **MCP server** (for Claude Code), and includes a **Web UI** for inspection. No cloud required.

## How It Works

```
                      ┌──────────────┐
                      │   YOUR CODE  │
                      │   YOUR CHAT  │
                      │   YOUR LOGS  │
                      └──────┬───────┘
                             │
                    ┌────────▼────────┐
                    │   I N G E S T   │
                    │   normalize +    │
                    │   classify       │
                    └────────┬────────┘
                             │
              ┌──────────────▼──────────────┐
              │         F O L D             │
              │                             │
              │   score → route → link      │
              │                             │
              │  ┌─────┐ ┌──────┐ ┌──────┐ │
              │  │ 🔴  │ │ 🟡   │ │ 🔵   │ │
              │  │ HOT │ │ WARM │ │ COLD │ │
              │  │     │ │      │ │      │ │
              │  │full │ │compact│ │archived│
              │  │text │ │summary│ │indexed│ │
              │  └──┬──┘ └──┬───┘ └──┬───┘ │
              │     │       │        │     │
              └─────┼───────┼────────┼─────┘
                    │       │        │
              ┌─────▼───────▼────────▼─────┐
              │    PERSISTENT STORAGE       │
              │    SQLite · Embeddings      │
              │    Dependency Graph         │
              └─────────────┬───────────────┘
                            │
              ┌─────────────▼───────────────┐
              │    M C P   S E R V E R      │
              │    C L I   T O O L S        │
              │    W E B   U I              │
              └─────────────────────────────┘
```

### The Three Tiers

| Tier | What happens | When you'd see it |
|------|-------------|-------------------|
| 🔴 **Hot** | Full text included in the prompt | "Must use JWT auth" — a constraint you can't ignore |
| 🟡 **Warm** | Compressed into a structured summary | A useful API doc — good to know, not needed verbatim |
| 🔵 **Cold** | Archived and indexed, retrieved on demand | A log from 3 days ago — probably irrelevant, but searchable |

### Scoring Factors

Every chunk gets a composite score from:

| Factor | Weight | What it measures |
|--------|--------|-----------------|
| **Semantic similarity** | 30% | How closely does this match the current task? |
| **Constraint priority** | 25% | Is this a hard requirement or just information? |
| **Recency** | 20% | Was this produced in the last few minutes or days ago? |
| **Redundancy** | 10% | Is this saying the same thing as 5 other chunks? |
| **Dependencies** | 15% | Does a hot chunk depend on this? |

---

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/BColsey/spacefolding.git
cd spacefolding
docker compose up --build
```

### Local

```bash
git clone https://github.com/BColsey/spacefolding.git
cd spacefolding
npm install
npm run build

# Download the embedding model (optional but recommended)
node dist/main.js download-model

# Start the MCP server
node dist/main.js serve
```

### Verify it works

```bash
node dist/main.js health
# → {"status":"ok","chunks":0}

node dist/main.js ingest README.md
# → ✓ abc12345 README.md

node dist/main.js score --task "How does routing work?"
# → === HOT ===    === WARM ===    === COLD ===
# →                                abc12345 (0.35)

node dist/main.js symbols src/core/scorer.ts
# → class  ContextScorer  line 11
```

---

## MCP Tools

Spacefolding exposes 6 MCP tools designed for Claude Code integration.

### Setup

Add to `.claude/settings.json`:

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

See the [full integration guide](docs/integration-guide.md) for Docker setup and advanced options.

### Tool Reference

| Tool | What it does |
|------|-------------|
| `ingest_context` | Add text, code, diffs, logs, or constraints to the context store |
| `score_context` | Score all chunks against a task and route into hot/warm/cold |
| `compress_context` | Compress specified chunks into a structured summary |
| `get_relevant_memory` | Search cold/warm storage for chunks relevant to a task |
| `update_context_graph` | Add or remove dependency links between chunks |
| `explain_routing` | Show exactly why each chunk was routed to its tier, with reasons |

### Quick Example

```
User: "Fix the auth bug in login.ts"

→ ingest_context(source="conversation", text="Fix the auth bug", type="instruction")
→ ingest_context(source="file", text=<login.ts>, path="src/auth/login.ts")
→ ingest_context(source="conversation", text="Must use JWT", type="constraint")
→ ingest_context(source="log", text="ERROR 401 at /api/login")

→ score_context(task={text: "Fix auth bug in login.ts"})

  🔴 HOT:  [constraint "Must use JWT", code login.ts]
  🟡 WARM: [log "ERROR 401"]
  🔵 COLD: [background "Project was started in 2020"]
```

---

## CLI Reference

```bash
spacefolding serve                    # Start MCP server (default)
spacefolding health                   # Health check
spacefolding ingest <path>            # Ingest a file or directory
spacefolding watch <path>             # Watch for file changes
spacefolding score --task "..."       # Score context against a task
spacefolding explain --task "..."     # Explain routing decisions
spacefolding graph --chunk <id>       # View dependency graph
spacefolding symbols <path>           # Extract code symbols
spacefolding export <file.json>       # Export memory state
spacefolding import <file.json>       # Import memory state
spacefolding download-model           # Download embedding model
```

---

## Architecture

```
src/
├── core/                  # Scoring, routing, classification, ingestion
│   ├── classifier.ts          Type detection (constraint, code, log, etc.)
│   ├── scorer.ts              Multi-factor relevance scoring
│   ├── router.ts              Hot/warm/cold tier routing
│   ├── ingester.ts            Normalize raw input into chunks
│   ├── watcher.ts             File watching via chokidar
│   └── git-aware.ts           Git diff parsing
│
├── providers/             # Pluggable model/logic interfaces
│   ├── local-embedding.ts     ONNX embeddings (HuggingFace)
│   ├── local-compression.ts   Enhanced summarization
│   ├── deterministic-*.ts     Hash/keyword fallbacks (zero deps)
│   ├── symbol-extractor.ts    Regex code symbol extraction
│   └── token-estimator.ts     Token count estimation
│
├── storage/               # Persistence
│   ├── schema.ts              SQLite DDL + migrations
│   └── repository.ts          CRUD for chunks, deps, routing history
│
├── pipeline/              # Orchestration
│   └── orchestrator.ts        ingest→score→route→compress→persist
│
├── mcp/                   # Model Context Protocol server
│   └── server.ts              6 tools, stdio + SSE transport
│
├── web/                   # Browser UI
│   └── server.ts              HTTP server + inline SPA
│
├── cli/                   # Command-line interface
│   ├── index.ts               Commander.js CLI
│   └── commands/
│       └── export-import.ts
│
└── types/                 # Shared TypeScript types
    └── index.ts
```

**42 tests** across 6 test files covering scoring, routing, classification, symbol extraction, and integration.

---

## Configuration

All configuration is via environment variables:

| Variable | Default | What it controls |
|----------|---------|-----------------|
| `DB_PATH` | `./data/spacefolding.db` | SQLite database location |
| `MODEL_PATH` | `./data/models` | Where embedding models are cached |
| `EMBEDDING_PROVIDER` | `deterministic` | `local` (ONNX) or `deterministic` (hash) |
| `EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | HuggingFace model ID |
| `COMPRESSION_PROVIDER` | `deterministic` | `deterministic`, `local`, or `llm` |
| `WEB_PORT` | `0` (off) | Port for web UI (e.g. `8080`) |
| `TRANSPORT` | `stdio` | MCP transport: `stdio` or `sse` |
| `PORT` | `3000` | SSE transport port |
| `USE_GPU` | `0` | Enable GPU for embeddings |

See [config.example.json](config.example.json) for routing weight tuning.

---

## Local Models

Spacefolding can use **real local embedding models** that run in-process on CPU — no API keys, no cloud.

```bash
# Download the default model (~80MB)
node dist/main.js download-model

# Or a specific one
node dist/main.js download-model --model Xenova/bge-small-en-v1.5
```

| Model | Size | Best for |
|-------|------|----------|
| `Xenova/all-MiniLM-L6-v2` | ~80MB | **Default.** Fast, good quality |
| `Xenova/bge-small-en-v1.5` | ~130MB | Higher accuracy |
| `Xenova/gte-small` | ~130MB | General-purpose alternative |

If no model is downloaded, Spacefolding uses **deterministic hash-based embeddings** as a zero-dependency fallback. It always works.

---

## LLM Compression

Use any OpenAI-compatible API to compress warm context with a real language model:

```bash
COMPRESSION_PROVIDER=llm \
LLM_COMPRESSION_ENDPOINT=https://api.openai.com/v1/chat/completions \
LLM_COMPRESSION_API_KEY=sk-... \
LLM_COMPRESSION_MODEL=gpt-4o-mini \
node dist/main.js serve
```

Works with **any** OpenAI-compatible endpoint: OpenAI, Anthropic (via proxy), Azure OpenAI, Ollama, LM Studio, vLLM, etc.

The LLM receives a structured prompt asking it to extract constraints, facts, and code signatures — producing much higher-quality summaries than the deterministic or local providers.

If the API call fails (network, rate limit, invalid key), it **falls back to deterministic compression** automatically.

| Variable | Description |
|----------|-------------|
| `LLM_COMPRESSION_ENDPOINT` | API URL (e.g. `https://api.openai.com/v1/chat/completions`) |
| `LLM_COMPRESSION_API_KEY` | Your API key |
| `LLM_COMPRESSION_MODEL` | Model name (e.g. `gpt-4o-mini`) |
| `LLM_COMPRESSION_MAX_TOKENS` | Max response tokens (default: 500) |

---

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for:
- Bug reporting
- Feature suggestions
- Pull request workflow
- Development setup
- Code style guide

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

[MIT](LICENSE) — use it, fork it, ship it.

> **THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.**
> The authors are not liable for any damages. See [LICENSE](LICENSE) for full terms.
