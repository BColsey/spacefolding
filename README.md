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
  Local-first · RAG · Docker · MCP · CLI · Web UI
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#how-it-works">How It Works</a> ·
  <a href="#mcp-tools">MCP Tools</a> ·
  <a href="#cli-reference">CLI</a> ·
  <a href="docs/configuration.md">Config</a> ·
  <a href="docs/integration-guide.md">Claude Code</a> ·
  <a href="benchmarks/RESULTS.md">Benchmarks</a>
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

### Features at a Glance

| Feature | Description |
|---------|-------------|
| 🧠 **Smart Routing** | Score + route context into hot/warm/cold tiers |
| 🔍 **Hybrid RAG** | Vector search + full-text search (FTS5) + graph traversal, fused with Reciprocal Rank Fusion |
| ⚡ **GPU Embeddings** | CUDA-accelerated embeddings via Python subprocess — 12x faster than CPU |
| 📦 **LLM Compression** | Use OpenAI, Ollama, or any compatible API to compress warm context |
| 🔌 **MCP Server** | 8 tools for Claude Code integration via stdio or SSE |
| ✂️ **Context Chunking** | Auto-split oversized files at code/markdown/paragraph boundaries |
| 🐳 **Docker-first** | One-command setup with persistent storage |
| 🧊 **Local Embeddings** | ONNX models run in-process — no GPU or cloud needed |
| 🔄 **File Watching** | Auto-ingest file changes with chokidar |
| 🔀 **Git-Aware** | Parse diffs, score changed files higher |
| 🔍 **Symbol Extraction** | Pull functions, classes, interfaces from source files |
| 🌐 **Web UI** | Browser-based chunk inspection and routing visualization |
| 📤 **Export/Import** | Transfer memory state between instances |

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
                    │   chunk → embed  │
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
         ┌──────────▼───────▼────────▼──────────┐
         │          PERSISTENT STORAGE            │
         │   SQLite · Vector Index · FTS5        │
         │   Embeddings · Dependency Graph        │
         └─────────────────┬─────────────────────┘
                           │
         ┌─────────────────▼─────────────────────┐
         │          R E T R I E V A L            │
         │                                       │
         │   vector search + FTS5 + graph walk   │
         │   → Reciprocal Rank Fusion            │
         │   → budget fill (token limit)         │
         └─────────────────┬─────────────────────┘
                           │
              ┌────────────▼────────────┐
              │    M C P   S E R V E R  │
              │    C L I   T O O L S    │
              │    W E B   U I          │
              └─────────────────────────┘
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

# Hybrid RAG retrieval
node dist/main.js retrieve --query "how does authentication work"
# → Intent: explain | Strategy: vector | Budget: 600/100000 tokens (1%)
# → [WARM] abc12345 src/auth.ts ~300 tokens (vector+fts)

node dist/main.js symbols src/core/scorer.ts
# → class  ContextScorer  line 11
```

---

## MCP Tools

Spacefolding exposes 11 MCP tools designed for Claude Code integration.

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
| `ingest_context` | Add text, code, diffs, logs, or constraints — auto-chunks if oversized |
| `ingest_directory` | Bulk-ingest all files in a directory tree (skips node_modules, .git, binaries) |
| `score_context` | Score chunks against a task and route into hot/warm/cold (vector-filtered for large stores) |
| `compress_context` | Compress specified chunks into a structured summary |
| `get_relevant_memory` | Search storage for chunks relevant to a task (hybrid retrieval) |
| `retrieve_context` | **Hybrid RAG retrieval** — vector + FTS5 + graph, with token budget control |
| `iterative_retrieve` | Multi-round retrieval with automatic query expansion |
| `update_context_graph` | Add or remove dependency links between chunks |
| `explain_routing` | Show exactly why each chunk was routed to its tier, with reasons |
| `list_context` | Show what's been ingested: chunk counts, token totals, per-file breakdown |
| `delete_context` | Delete specific context chunks by ID |

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

→ retrieve_context(query="authentication flow", maxTokens=50000)

  Returns: chunks ranked by fused vector+keyword+graph score,
  selected to fit within the token budget, with retrieval sources.
```

---

## CLI Reference

```bash
spacefolding serve                    # Start MCP server (default)
spacefolding health                   # Health check
spacefolding ingest <path>            # Ingest a file or directory
spacefolding watch <path>             # Watch for file changes
spacefolding score --task "..."       # Score context against a task
spacefolding retrieve --query "..."   # Hybrid RAG retrieval
spacefolding explain --task "..."     # Explain routing decisions
spacefolding graph --chunk <id>       # View dependency graph
spacefolding symbols <path>           # Extract code symbols
spacefolding export <file.json>       # Export memory state
spacefolding import <file.json>       # Import memory state
spacefolding download-model           # Download embedding model
```

---

## Context Chunking

When you ingest a file larger than the configured token limit, Spacefolding **automatically splits it** into sub-chunks:

- **Code files** — splits at function/class boundaries, preserves imports in each chunk
- **Markdown** — splits at `##`/`###` headers, keeps sections intact
- **Plain text** — recursive splitting at paragraph → sentence → word boundaries
- **Overlap** — 200 tokens of overlap between chunks to prevent information loss at boundaries

Split chunks are linked via parent-child relationships and dependency edges. Children are independently scored and routed — different parts of a large file can end up in different tiers.

```bash
# Configure chunking
CHUNK_MAX_TOKENS=2000     # Max tokens per sub-chunk (default: 2000)
CHUNK_OVERLAP_TOKENS=200  # Overlap between chunks (default: 200)
CHUNK_STRATEGY=auto       # auto, recursive, code, markdown (default: auto)
```

---

## Hybrid RAG Retrieval

The `retrieve_context` tool runs a multi-strategy search pipeline:

```
Query → Intent Detection → [Vector + FTS5 + Graph] → RRF Fusion → Budget Fill → Results
```

1. **Vector search** — cosine similarity against stored embeddings
2. **FTS5 full-text search** — BM25-ranked keyword matching
3. **Graph traversal** — follow dependency links from seed results
4. **Reciprocal Rank Fusion** — merge all results, items found by multiple strategies rank highest
5. **Budget controller** — select top results that fit within your token limit

### Query Planning

The system automatically detects query intent and adjusts strategy:

| Intent | Example | Strategy | Token budget |
|--------|---------|----------|-------------|
| **debug** | "fix the auth error" | hybrid + 2 hops | 60% |
| **implement** | "add rate limiting" | hybrid + 1 hop | 40% |
| **explain** | "how does routing work" | vector + 1 hop | 30% |
| **code_search** | "where is the auth middleware" | text only | 35% |
| **general** | anything else | hybrid + 1 hop | 50% |

### Benchmarks

We evaluated retrieval accuracy against ground-truth on 20 tasks across 6 embedding models and 6 strategies. **With GTE-ModernBERT on GPU, Spacefolding beats keyword grep on every metric:**

| Metric | Keyword Grep | Spacefolding (GPU) | Δ |
|--------|:-----------:|:------------------:|:-:|
| Recall@10 | 0.787 | **0.846** | +7.5% |
| NDCG@10 | 0.674 | **0.787** | +16.8% |
| MRR | 0.692 | **0.823** | +18.9% |
| Recall@20 | 0.850 | **0.942** | +10.8% |

See [benchmarks/RESULTS.md](benchmarks/RESULTS.md) for full results, [benchmarks/MODEL-COMPARISON.md](benchmarks/MODEL-COMPARISON.md) for model comparisons, and [benchmarks/ABLATION.md](benchmarks/ABLATION.md) for the ablation study.

---

## Architecture

```
src/
├── core/                  # Scoring, routing, classification, ingestion
│   ├── classifier.ts          Type detection (constraint, code, log, etc.)
│   ├── scorer.ts              Multi-factor relevance scoring
│   ├── router.ts              Hot/warm/cold tier routing
│   ├── ingester.ts            Normalize + auto-chunk input
│   ├── retriever.ts           Hybrid RAG: vector + FTS5 + graph + RRF fusion
│   ├── budget.ts              Token-budget-aware result selection
│   ├── query-planner.ts       Intent detection + query expansion
│   ├── chunker.ts             Auto-split: recursive, code, markdown strategies
│   ├── watcher.ts             File watching via chokidar
│   └── git-aware.ts           Git diff parsing
│
├── providers/             # Pluggable model/logic interfaces
│   ├── local-embedding.ts     ONNX embeddings (HuggingFace)
│   ├── gpu-embedding.ts       CUDA embeddings via Python subprocess (GTE-ModernBERT)
│   ├── llm-compression.ts     LLM-powered compression (OpenAI-compatible API)
│   ├── local-compression.ts   Enhanced deterministic summarization
│   ├── deterministic-*.ts     Hash/keyword fallbacks (zero deps)
│   ├── symbol-extractor.ts    Regex code symbol extraction
│   └── token-estimator.ts     Token count estimation
│
├── storage/               # Persistence + search
│   ├── schema.ts              SQLite DDL + migrations (v1-v3)
│   └── repository.ts          CRUD + vector store + FTS5
│
├── pipeline/              # Orchestration
│   └── orchestrator.ts        ingest→embed→score→route→compress→persist
│
├── mcp/                   # Model Context Protocol server
│   └── server.ts              11 tools, stdio + SSE transport
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

**74 tests** across 9 test files covering scoring, routing, classification, chunking, RAG retrieval, symbol extraction, integration, and usability features.

**Benchmarks** in `benchmarks/` — 6 documents covering retrieval evaluation, ablation studies across 6 embedding models, and model comparison.

---

## Configuration

All configuration is via environment variables:

| Variable | Default | What it controls |
|----------|---------|-----------------|
| `DB_PATH` | `./data/spacefolding.db` | SQLite database location |
| `MODEL_PATH` | `./data/models` | Where embedding models are cached |
| `EMBEDDING_PROVIDER` | `local` | `local` (ONNX), `gpu` (CUDA), or `deterministic` (hash) |
| `EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | HuggingFace model ID (for `local`) |
| `GPU_EMBEDDING_MODEL` | `Alibaba-NLP/gte-modernbert-base` | sentence-transformer model (for `gpu`) |
| `GPU_EMBEDDING_DEVICE` | `cuda` | PyTorch device: `cuda` or `cpu` |
| `PYTHON_PATH` | `python3` | Python executable for GPU embedder |
| `COMPRESSION_PROVIDER` | `deterministic` | `deterministic`, `local`, or `llm` |
| `CHUNK_MAX_TOKENS` | `2000` | Max tokens per sub-chunk |
| `CHUNK_OVERLAP_TOKENS` | `200` | Overlap between chunks |
| `CHUNK_STRATEGY` | `auto` | `auto`, `recursive`, `code`, `markdown` |
| `WEB_PORT` | `0` (off) | Port for web UI (e.g. `8080`) |
| `TRANSPORT` | `stdio` | MCP transport: `stdio` or `sse` |
| `PORT` | `3000` | SSE transport port |
| `USE_GPU` | `0` | Enable GPU for embeddings |

See [config.example.json](config.example.json) for routing weight tuning.

---

## Embedding Models

Spacefolding supports three embedding providers:

### GPU Embeddings (recommended)

For best retrieval quality, use GPU-accelerated embeddings with a CUDA-capable GPU:

```bash
pip install sentence-transformers torch
EMBEDDING_PROVIDER=gpu node dist/main.js serve
```

The GPU provider spawns a Python subprocess (`scripts/gpu-embedder.py`) that uses sentence-transformers with PyTorch CUDA. It communicates via JSON-RPC over stdin/stdout.

| Model | Dims | Size | Speed | R@10 |
|-------|:----:|:----:|:-----:|:----:|
| `Alibaba-NLP/gte-modernbert-base` | 768 | 560MB | 16ms | **0.846** |
| `BAAI/bge-m3` | 1024 | 560MB | 11ms | 0.796 |
| `all-mpnet-base-v2` | 768 | 420MB | 7ms | 0.729 |

### Local CPU Embeddings

Spacefolding can also use **real local embedding models** that run in-process on CPU — no API keys, no cloud, no GPU.

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

### Deterministic Fallback

If no model is downloaded, Spacefolding uses **deterministic hash-based embeddings** as a zero-dependency fallback. It always works — but produces near-random vectors (R@10 = 0.362). Real embeddings are strongly recommended.

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
