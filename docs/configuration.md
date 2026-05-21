# Configuration Guide

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PATH` | `./data/spacefolding.db` | SQLite database path |
| `MODEL_PATH` | `./data/models` | Local model cache directory |
| `EMBEDDING_PROVIDER` | `local` | `local` (ONNX), `gpu` (CUDA), or `deterministic` (hash-based) |
| `EMBEDDING_MODEL` | `Xenova/bge-small-en-v1.5` | HuggingFace model ID (for `local` provider) |
| `GPU_EMBEDDING_MODEL` | `Alibaba-NLP/gte-modernbert-base` | sentence-transformer model (for `gpu` provider) |
| `GPU_EMBEDDING_DEVICE` | `cuda` | PyTorch device: `cuda` or `cpu` |
| `PYTHON_PATH` | `python3` | Python executable for GPU embedding and LLMLingua subprocesses |
| `COMPRESSION_PROVIDER` | `deterministic` | `deterministic`, `local`, `llm`, or `llmlingua` |
| `LLMLINGUA_MODEL` | `microsoft/llmlingua-2-xlm-roberta-large-meetingbank` | Model ID for LLMLingua compression |
| `LLMLINGUA_RATE` | `0.5` | Target compression rate for LLMLingua |
| `CHUNK_MAX_TOKENS` | `2000` | Max tokens per sub-chunk when splitting |
| `CHUNK_OVERLAP_TOKENS` | `200` | Overlap between consecutive chunks |
| `CHUNK_STRATEGY` | `auto` | `auto`, `recursive`, `code`, `markdown` |
| `CHUNK_TREE_SITTER` | unset | Set to `1` to enable tree-sitter-backed code splitting when available |
| `WEB_PORT` | `0` | Port for web UI (set to `8080` to enable) |
| `TRANSPORT` | `stdio` | MCP transport: `stdio` or `sse` |
| `PORT` | `3000` | Port for SSE transport |
| `USE_GPU` | `0` | Set to `1` to enable GPU for embeddings |
| `MAX_CHUNKS` | `10000` | Max chunk count before auto-eviction of oldest chunks |
| `NODE_ENV` | `production` | Node environment |

## GPU Embeddings (CUDA)

Requires: `pip install sentence-transformers torch`

```bash
EMBEDDING_PROVIDER=gpu
GPU_EMBEDDING_MODEL=Alibaba-NLP/gte-modernbert-base  # Best: R@10=0.846, beats keyword
GPU_EMBEDDING_DEVICE=cuda              # or 'cpu' for fallback
```

The GPU provider runs a Python subprocess (`scripts/gpu-embedder.py`) that uses
PyTorch with CUDA for fast inference. It communicates via JSON-RPC over stdin/stdout.

## Routing Weights

The scoring engine uses configurable weights to balance factors:

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
  }
}
```

### What each weight controls

- **Semantic (0.3)** — How similar is this chunk to the current task? Requires an embedding model for best results.
- **Constraint (0.25)** — Is this a hard requirement? Constraints and instructions get a significant boost.
- **Recency (0.2)** — Newer chunks score higher. 7-day linear decay to zero.
- **Redundancy (0.1)** — If this says the same thing as other chunks, it gets penalized.
- **Dependency (0.15)** — If a hot chunk depends on this, it gets pulled up.

### Thresholds

- **Hot threshold (0.7)** — Chunks scoring above this go into the prompt verbatim.
- **Warm threshold (0.4)** — Chunks above this get compressed into summaries.

### Hot tier cap

The hot tier is capped at **60% of total chunks** to prevent runaway promotion. If dependency closure pushes hot past 60%, the lowest-scoring hot chunks are demoted back to warm.

## Provider Configuration

### Embedding Provider

**Local ONNX model (default):**
```
EMBEDDING_PROVIDER=local
EMBEDDING_MODEL=Xenova/bge-small-en-v1.5
```
Real sentence embeddings running in-process. Auto-downloads the model on first use (~130MB). BGE-small achieves MTEB retrieval score of 51.68, significantly outperforming the previous default (all-MiniLM-L6-v2 at 42).

**Deterministic fallback:**
```
EMBEDDING_PROVIDER=deterministic
```
Hash-based pseudo-vectors. No model download needed. Works offline. Near-random accuracy — only use as a last resort.

### Embedding Backfill and Vector Index

Embeddings are persisted in `chunk_embeddings`. Vector search uses a derived cache:

- `sqlite-vec` is used when the native extension can load.
- An in-memory brute-force cache is used as a fallback.
- The derived index is rebuilt from persisted embeddings when dimensions change or the index is initialized, so `chunk_embeddings` remains the source of truth.

Backfill embeddings after switching providers/models or after ingesting content without embeddings:

```bash
node dist/main.js backfill-embeddings
EMBEDDING_PROVIDER=local node dist/main.js backfill-embeddings --model Xenova/bge-small-en-v1.5
```

## Retrieval Defaults

Project ingestion and retrieval are configured per MCP/CLI call rather than with environment variables:

- `ingest_project` includes source, README/docs, `.env.example`, common config files, and agent instruction files by default.
- Tests/specs and benchmark directories are skipped by default; pass `includeTests` or `includeBenchmarks` when that context is relevant.
- `retrieve_context` defaults to `mode: "focused"`, which targets compact context by query complexity: 8k tokens for narrow tasks, 17k for moderate tasks, and 24k for broad tasks, always bounded by the caller's `maxTokens`.
- Use `mode: "broad"` for higher recall on ambiguous tasks, or `mode: "exhaustive"` for manual inspection and benchmark ranking.

### Compression Provider

**Deterministic (default):**
```
COMPRESSION_PROVIDER=deterministic
```
Rule-based: extracts constraints verbatim, first sentences of facts, code signatures.

**Local enhanced:**
```
COMPRESSION_PROVIDER=local
```
Smarter extraction with structured sections. Degrades to deterministic if no model is available.

**LLM-powered (API):**
```
COMPRESSION_PROVIDER=llm
LLM_COMPRESSION_ENDPOINT=https://api.openai.com/v1/chat/completions
LLM_COMPRESSION_API_KEY=sk-...
LLM_COMPRESSION_MODEL=gpt-4o-mini
```
Uses any OpenAI-compatible API to compress warm context with a real LLM. Produces much higher-quality summaries than deterministic or local providers.

| Variable | Required | Description |
|----------|----------|-------------|
| `LLM_COMPRESSION_ENDPOINT` | ✅ | API endpoint URL (any OpenAI-compatible) |
| `LLM_COMPRESSION_API_KEY` | ✅ | API key |
| `LLM_COMPRESSION_MODEL` | ✅ | Model name (e.g. `gpt-4o-mini`, `claude-3-haiku-20240307`) |
| `LLM_COMPRESSION_MAX_TOKENS` | | Max response tokens (default: 500) |
| `LLM_COMPRESSION_HEADERS` | | JSON string of extra headers |

Works with OpenAI, Anthropic (via proxy), Azure OpenAI, Ollama, LM Studio, or any OpenAI-compatible endpoint. Falls back to deterministic if the API call fails.

**LLMLingua token compression:**
```
pip install llmlingua
COMPRESSION_PROVIDER=llmlingua
LLMLINGUA_MODEL=microsoft/llmlingua-2-xlm-roberta-large-meetingbank
LLMLINGUA_RATE=0.5
```
Runs `scripts/llmlingua-compressor.py` as a Python JSON-RPC subprocess. This is optional and only needed when you want token-level compression comparisons.

## Docker Compose Configuration

```yaml
services:
  spacefolding:
    build: .
    volumes:
      - ./data:/app/data          # DB + model cache
      - ./workspace:/workspace:ro # Your codebase
    ports:
      - "3000:3000"               # SSE transport
      - "8080:8080"               # Web UI
    environment:
      - EMBEDDING_PROVIDER=local
      - EMBEDDING_MODEL=Xenova/bge-small-en-v1.5
      - WEB_PORT=8080
```
