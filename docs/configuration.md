# Configuration Guide

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PATH` | `./data/spacefolding.db` | SQLite database path |
| `MODEL_PATH` | `./data/models` | Local model cache directory |
| `EMBEDDING_PROVIDER` | `deterministic` | `local` (ONNX), `gpu` (CUDA), or `deterministic` (hash-based) |
| `EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | HuggingFace model ID (for `local` provider) |
| `GPU_EMBEDDING_MODEL` | `all-mpnet-base-v2` | sentence-transformer model (for `gpu` provider) |
| `GPU_EMBEDDING_DEVICE` | `cuda` | PyTorch device: `cuda` or `cpu` |
| `PYTHON_PATH` | `python3` | Python executable for GPU embedder |
| `COMPRESSION_PROVIDER` | `deterministic` | `deterministic`, `local`, or `llm` |
| `CHUNK_MAX_TOKENS` | `2000` | Max tokens per sub-chunk when splitting |
| `CHUNK_OVERLAP_TOKENS` | `200` | Overlap between consecutive chunks |
| `CHUNK_STRATEGY` | `auto` | `auto`, `recursive`, `code`, `markdown` |
| `WEB_PORT` | `0` | Port for web UI (set to `8080` to enable) |
| `TRANSPORT` | `stdio` | MCP transport: `stdio` or `sse` |
| `PORT` | `3000` | Port for SSE transport |
| `USE_GPU` | `0` | Set to `1` to enable GPU for embeddings |
| `NODE_ENV` | `production` | Node environment |

## GPU Embeddings (CUDA)

Requires: `pip install sentence-transformers torch`

```bash
EMBEDDING_PROVIDER=gpu
GPU_EMBEDDING_MODEL=all-mpnet-base-v2  # 768-dim, best quality
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

**Deterministic (default):**
```
EMBEDDING_PROVIDER=deterministic
```
Hash-based pseudo-vectors. No model download needed. Works offline. Less accurate semantic matching.

**Local ONNX model:**
```
EMBEDDING_PROVIDER=local
EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
```
Real sentence embeddings running in-process. Requires model download (~80MB). Much better semantic matching.

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
      - EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
      - WEB_PORT=8080
```
