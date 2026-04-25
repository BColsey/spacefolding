# Spacefolding

**Intelligent Context Compression and Routing for Coding Agents**

```
         ╔═══════════════════════════════════════════╗
         ║   S P A C E F O L D I N G                ║
         ║   Fold the infinite context space         ║
         ║   into what fits in your prompt window    ║
         ╚═══════════════════════════════════════════╝
```

Spacefolding is a local-first application, Docker container, CLI, and MCP server that acts as an intelligent context-management layer for coding agents like Claude Code. Its job is to continuously analyze candidate context before it is sent to a large model, determine what is necessary, compress what is useful but not critical, and exclude what is low-value — while preserving a path to recover it later.

The name comes from the concept of **folding space**: taking an impossibly large context space and collapsing it into a compact, navigable form that fits within the finite window of an LLM prompt.

## How It Works

Spacefolding maintains **three tiers** of context — like folding space into tighter and tighter geometries:

| Tier | Analogy | Description | Example |
|------|---------|-------------|---------|
| **Hot** | Unfolded — full detail | Include verbatim in the next prompt | Current constraints, directly relevant code, explicit instructions |
| **Warm** | Partially folded — compressed | Compress into structured summaries | Useful background, related files, prior summaries |
| **Cold** | Fully folded — archived | Exclude but keep indexed and retrievable | Stale background, redundant info, old logs |

### Architecture

```
  ┌─────────────────────────────────────────────────────────┐
  │                    INPUT SPACE                          │
  │   conversation • files • diffs • logs • summaries       │
  └─────────────────────────┬───────────────────────────────┘
                            │
                            ▼
  ┌─────────────────────────────────────────────────────────┐
  │                      FOLD ENGINE                        │
  │                                                         │
  │   ┌──────────┐   ┌───────────┐   ┌──────────────┐     │
  │   │ CLASSIFY │──▶│   SCORE   │──▶│    ROUTE     │     │
  │   │ type      │   │ relevance │   │ hot/warm/cold│     │
  │   └──────────┘   └───────────┘   └──────┬───────┘     │
  │                                         │              │
  │                          ┌──────────────┼──────────┐   │
  │                          │              │          │   │
  │                     ┌────▼───┐   ┌──────▼──┐  ┌───▼────┐
  │                     │  HOT   │   │  WARM   │  │  COLD  │
  │                     │unfolded│   │ folded  │  │archived│
  │                     │verbatim│   │compressed│ │indexed │
  │                     └────────┘   └─────────┘  └────────┘
  │                          │              │          │   │
  │                     prompt in    summary in    retrieval │
  │                     full detail  compact form  on demand│
  └─────────────────────────────────────────────────────────┘
                            │
                            ▼
  ┌─────────────────────────────────────────────────────────┐
  │                  STORAGE LAYER                          │
  │   SQLite DB │ Vector Index │ Dependency Graph           │
  │   (local volume, no cloud dependency)                   │
  └─────────────────────────┬───────────────────────────────┘
                            │
                            ▼
  ┌─────────────────────────────────────────────────────────┐
  │               MCP SERVER / CLI                          │
  │                                                         │
  │   score_context        ingest_context                   │
  │   compress_context     get_relevant_memory              │
  │   update_context_graph explain_routing                  │
  │                                                         │
  │   Claude Code ←── stdio / SSE ──→ Spacefolding          │
  └─────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. With Docker (Recommended)

```bash
# Clone and start
docker compose up --build

# The container starts the MCP server on stdio by default
```

### 2. Without Docker

```bash
npm install
npm run build
npm start        # starts MCP server on stdio
```

### 3. Verify

```bash
# Health check
node dist/main.js health
# Output: {"status":"ok","chunks":0}

# Or inside Docker:
docker compose exec spacefolding node dist/main.js health
```

## Local Model Setup

Spacefolding can run with a **real local embedding model** for much better semantic similarity scoring. The recommended model is `Xenova/all-MiniLM-L6-v2` (~80MB), which runs entirely within the container on CPU — no GPU required, no external API calls.

### Option A: Pre-download before starting (Recommended)

```bash
# Without Docker:
npm run build
node dist/main.js download-model

# With Docker — download inside a temporary container:
docker compose run --rm spacefolding node dist/main.js download-model

# Specify a different model:
node dist/main.js download-model --model Xenova/all-MiniLM-L6-v2
```

This downloads the model to `./data/models/` (or whatever `MODEL_PATH` points to). The files are persisted in the Docker volume, so you only download once.

### Option B: Auto-download on first use

If no model is found locally, Spacefolding will automatically download it on the first embedding request. This may cause a slow first response.

### Supported Models

Any [ONNX-converted sentence-transformer model from HuggingFace](https://huggingface.co/models?pipeline_tag=feature-extraction&library=transformers.js) works. Recommended:

| Model | Size | Dimensions | Notes |
|-------|------|-----------|-------|
| `Xenova/all-MiniLM-L6-v2` | ~80MB | 384 | **Default**. Fast, good quality. |
| `Xenova/bge-small-en-v1.5` | ~130MB | 384 | Higher accuracy, slightly slower. |
| `Xenova/gte-small` | ~130MB | 384 | Good general-purpose alternative. |

### Model Persistence with Docker

The model cache is stored in the same volume as the database:

```yaml
volumes:
  - ./data:/app/data    # Contains both DB and models/
```

This means:
- Models survive `docker compose down`
- Models are shared across container restarts
- You can pre-populate `./data/models/` on the host

### Deterministic Fallback

If no model is available (no download, no network), Spacefolding falls back to **deterministic hash-based embeddings**. These are less accurate but require zero setup and work completely offline. The system always works — models just make it better.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PATH` | `./data/spacefolding.db` | SQLite database path |
| `MODEL_PATH` | `./data/models` | Local model cache directory |
| `EMBEDDING_PROVIDER` | `local` | `local` (ONNX model) or `deterministic` (hash-based) |
| `EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | HuggingFace model ID for embeddings |
| `TRANSPORT` | `stdio` | MCP transport: `stdio` or `sse` |
| `PORT` | `3000` | Port for SSE transport |
| `NODE_ENV` | `production` | Node environment |

### Configuration File

Copy `config.example.json` and modify routing weights, model settings, etc:

```json
{
  "routing": {
    "weights": {
      "semantic": 0.3,
      "constraint": 0.25,
      "recency": 0.2,
      "redundancy": 0.1,
      "dependency": 0.15
    },
    "thresholds": {
      "hot": 0.7,
      "warm": 0.4
    }
  },
  "providers": {
    "embedding": {
      "type": "local",
      "modelId": "Xenova/all-MiniLM-L6-v2",
      "fallback": "deterministic"
    }
  }
}
```

### Persistent Data

The Docker setup mounts `./data` for everything:

```yaml
volumes:
  - ./data:/app/data          # DB + model cache
  - ./workspace:/workspace:ro # Read-only repo access
```

## MCP Integration with Claude Code

### Setup

Add to your Claude Code MCP settings (`.claude/settings.json` or `claude_desktop_config.json`):

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

Or for local execution:

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

### MCP Tools

#### `score_context`
Score and route context chunks into hot/warm/cold tiers.

```json
{
  "task": { "text": "Fix the authentication bug in login.ts" },
  "chunkIds": ["optional-chunk-id"]
}
```

Returns: `{ hot: [], warm: [], cold: [], scores: {}, reasons: {} }`

#### `compress_context`
Compress warm-context chunks into a structured summary.

```json
{
  "task": { "text": "Fix auth bug" },
  "chunkIds": ["chunk-id-1", "chunk-id-2"]
}
```

Returns: `{ summary: "...", retainedFacts: [], retainedConstraints: [], sourceChunkIds: [] }`

#### `get_relevant_memory`
Retrieve context from storage relevant to a task.

```json
{
  "task": { "text": "How does authentication work?" },
  "filters": { "type": "code", "path": "src/auth" }
}
```

Returns: `{ chunks: [], explanations: [] }`

#### `ingest_context`
Add a new context item to the system.

```json
{
  "source": "conversation",
  "text": "Must use JWT for all API endpoints",
  "type": "constraint"
}
```

Returns: `{ chunkId: "uuid" }`

#### `update_context_graph`
Add or remove dependency links between chunks.

```json
{
  "chunkId": "primary-id",
  "operation": "add",
  "dependencies": [
    { "fromId": "a", "toId": "b", "type": "references", "weight": 0.7 }
  ]
}
```

#### `explain_routing`
Explain why chunks were routed the way they were.

```json
{
  "task": { "text": "Fix auth bug" },
  "chunkId": "optional-specific-chunk"
}
```

Returns: `{ routing: [{ chunkId, tier, score, reasons }], summary: "..." }`

## CLI Usage

```bash
# Start MCP server (default)
spacefolding serve

# Download local embedding model
spacefolding download-model

# Ingest files
spacefolding ingest /workspace/src

# Watch files for automatic ingestion
spacefolding watch /workspace/src

# Score context against a task
spacefolding score --task "Fix the authentication bug"

# Explain routing decisions
spacefolding explain --task "Fix auth bug" --chunk abc123

# View dependency graph
spacefolding graph --chunk abc123

# Extract symbols from a file
spacefolding symbols src/core/scorer.ts

# Export/import memory state
spacefolding export backup.json
spacefolding import backup.json

# Health check
spacefolding health
```

### Inside Docker

```bash
docker compose exec spacefolding node dist/main.js download-model
docker compose exec spacefolding node dist/main.js ingest /workspace
docker compose exec spacefolding node dist/main.js score --task "Refactor auth flow"
docker compose exec spacefolding node dist/main.js explain --task "Fix CI failure"
docker compose exec spacefolding node dist/main.js health
```

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm test             # Run tests (32 tests)
npm run test:watch   # Watch mode
npm run lint         # Type check
npm run dev          # Development server with tsx
```

## Folder Structure

```
src/
├── types/           # TypeScript types and interfaces
│   └── index.ts
├── core/            # Core business logic
│   ├── classifier.ts    # Chunk type classification
│   ├── scorer.ts        # Multi-factor scoring engine
│   ├── router.ts        # Hot/Warm/Cold routing
│   ├── ingester.ts      # Context ingestion
│   ├── watcher.ts       # File watching (chokidar)
│   └── git-aware.ts     # Git diff parsing and scoring
├── providers/       # Pluggable provider implementations
│   ├── local-embedding.ts           # ONNX model embeddings (real ML)
│   ├── local-compression.ts         # Enhanced deterministic compression
│   ├── deterministic-embedding.ts   # Hash-based fallback
│   ├── deterministic-reranker.ts    # Keyword overlap reranking
│   ├── deterministic-compression.ts # Rule-based summarization
│   ├── dependency-analyzer.ts       # Pattern-based dependency detection
│   ├── symbol-extractor.ts          # Regex-based code symbol extraction
│   └── token-estimator.ts           # Token count estimation
├── storage/         # SQLite persistence
│   ├── schema.ts        # Database schema and migrations
│   └── repository.ts    # Data access layer
├── pipeline/        # Pipeline orchestration
│   └── orchestrator.ts  # Full pipeline: ingest→score→route→compress→persist
├── mcp/             # MCP server
│   └── server.ts        # 6 MCP tools for Claude Code
├── web/             # Web UI
│   └── server.ts        # HTTP server + inline SPA
├── cli/             # CLI interface
│   ├── index.ts         # Commander-based CLI
│   └── commands/        # CLI subcommands
│       └── export-import.ts
└── main.ts          # Entry point
tests/
├── classifier.test.ts    # 14 classification tests
├── scorer.test.ts        # 6 scoring tests
├── router.test.ts        # 9 routing tests
├── integration.test.ts   # 3 end-to-end tests
└── seed-data.ts          # Realistic test fixtures
```

## Model Providers

Spacefolding uses a provider pattern so you can swap implementations:

| Provider | Interface | Default | Purpose |
|----------|-----------|---------|---------|
| Embedding | `EmbeddingProvider` | `LocalEmbeddingProvider` (ONNX) | Real vector embeddings |
| Reranker | `RerankerProvider` | Keyword overlap | Re-rank results by relevance |
| Compression | `CompressionProvider` | Rule-based extraction | Summarize warm context |
| Token Estimator | `TokenEstimator` | Length/4 heuristic | Estimate token counts |
| Dependency Analyzer | `DependencyAnalyzer` | Pattern matching | Detect chunk relationships |

The local embedding model runs **in-process** using `@huggingface/transformers` (ONNX Runtime) — no separate model server needed. It downloads models from HuggingFace on first use and caches them to the `MODEL_PATH` directory.

## Routing Heuristics

The fold engine uses a blended routing strategy:

1. **Hard constraints** — Always favored toward hot
2. **Semantic relevance** — Local model cosine similarity to current task
3. **Recency** — Recent content scored higher (7-day decay)
4. **Redundancy penalty** — Similar chunks penalized
5. **Dependency closure** — Dependencies of hot chunks promoted
6. **Explicit instructions** — Action verbs promoted to hot
7. **Debug bias** — Recent error logs favored when task mentions debugging

## Additional Features

### File Watching

Automatically ingest file changes:
```bash
spacefolding watch /workspace/src
```
Watches for file adds, changes, and unlinks using chokidar. Debounces rapid changes (300ms).

### Git-Aware Diff Prioritization

Parse git diffs and score changed files:
```typescript
import { parseGitDiff, getRecentGitChanges } from './core/git-aware.js';
const changes = await getRecentGitChanges('/workspace');
// [{filePath: 'src/auth.ts', changeType: 'modified'}]
```

### Symbol Extraction

Extract code symbols (functions, classes, interfaces) from source files:
```bash
spacefolding symbols src/core/scorer.ts
# class  ContextScorer  line 11
# method  scoreChunks  line 20
```
Supports TypeScript, JavaScript, and Python via regex patterns.

### Export/Import State

Transfer memory state between instances:
```bash
spacefolding export backup.json
spacefolding import backup.json
```
Exports all chunks and dependencies as JSON.

### Enhanced Compression

`LocalCompressionProvider` provides smarter summarization with:
- Constraint text preserved verbatim
- Fact extraction (first 2 sentences)
- Code signature extraction (function/class headers)
- Structured summary with sections

### Web UI

Inspect chunk routing in a browser:
```bash
# Start with web UI enabled
docker compose up
# Visit http://localhost:8080
```
Features: chunk table, task scoring, routing visualization, dependency inspection.

### GPU Support

For faster embeddings with a GPU:
```yaml
# docker-compose.yml
environment:
  - USE_GPU=1
# Uncomment the deploy.resources section for NVIDIA GPU access
```

## Limitations & Future Work

- **Single-user** — Not designed for multi-user scenarios
- **Symbol extraction is regex-based** — Not full AST parsing
- **Local compression model** — Deterministic by default; real model integration is optional

## License

This project is licensed under the [MIT License](LICENSE).

## Disclaimer

**THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND**, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and noninfringement. In no event shall the authors or copyright holders be liable for any claim, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software.

This tool processes and stores source code, conversation text, and other data locally. The authors make no guarantees about data security, integrity, or fitness for any particular use case. Use at your own risk.
