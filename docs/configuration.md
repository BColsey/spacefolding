---
title: Configuration Reference
description: Environment variables, providers, retrieval defaults, routing weights, Docker, and web UI settings for Spacefolding.
last_updated: 2026-05-27
review_schedule: quarterly
owner: maintainers
doc_type: reference
---

# Configuration Reference

Spacefolding is configured with environment variables. The default Docker setup reads `.env` and persists data under `./data`.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `production` in Docker | Node runtime environment. |
| `DB_PATH` | `./data/spacefolding.db` | SQLite database path. |
| `MODEL_PATH` | `./data/models` | Local model cache directory. |
| `EMBEDDING_PROVIDER` | `local` | `local`, `gpu`, or `deterministic`. |
| `EMBEDDING_MODEL` | `Xenova/bge-small-en-v1.5` | HuggingFace model ID for local (transformers.js/ONNX) embeddings. Lightweight general-English fallback. |
| `GPU_EMBEDDING_MODEL` | `Salesforce/SFR-Embedding-Code-400M_R` | Sentence-transformer model for the `gpu` provider. Defaults to a code-specific model; accepts any sentence-transformers model id. |
| `GPU_EMBEDDING_DEVICE` | `cuda` | PyTorch device for GPU embeddings. |
| `PYTHON_PATH` | `python3` | Python executable for GPU embeddings and LLMLingua. |
| `PYTHON` | `python3` | Python executable for structural-index subprocesses. |
| `COMPRESSION_PROVIDER` | `deterministic` | `deterministic`, `local`, `llm`, or `llmlingua`. |
| `COMPRESSION_MODEL` | `Xenova/bge-small-en-v1.5` | Local compression model ID. |
| `LLM_COMPRESSION_ENDPOINT` | unset | OpenAI-compatible chat completions endpoint. |
| `LLM_COMPRESSION_API_KEY` | unset | API key for LLM compression. |
| `LLM_COMPRESSION_MODEL` | unset | Model name for LLM compression. |
| `LLM_COMPRESSION_MAX_TOKENS` | `500` | Max response tokens for LLM compression. |
| `LLM_COMPRESSION_HEADERS` | unset | JSON object of extra request headers. |
| `LLMLINGUA_MODEL` | `microsoft/llmlingua-2-xlm-roberta-large-meetingbank` | LLMLingua model ID. |
| `LLMLINGUA_RATE` | `0.5` | Target token compression rate. |
| `CHUNK_MAX_TOKENS` | `2000` | Max tokens per child chunk. |
| `CHUNK_OVERLAP_TOKENS` | `200` | Overlap between child chunks. |
| `CHUNK_STRATEGY` | `auto` | `auto`, `recursive`, `code`, or `markdown`. |
| `CHUNK_TREE_SITTER` | unset | Set to `1` for tree-sitter-backed code chunking when available. |
| `SPACEFOLDING_DISABLE_AST_SUBPROCESS` | unset | Set to `1` to disable AST subprocess indexing. |
| `WEB_PORT` | `0` | Web UI port. `0` disables the web UI. |
| `WEB_HOST` | `127.0.0.1` | Web UI bind address. Use `0.0.0.0` for Docker exposure. |
| `TRANSPORT` | `stdio` | MCP transport: `stdio` or `sse`. |
| `PORT` | `3000` | SSE transport port. |
| `USE_GPU` | `0` | Adds GPU-enabled text to MCP tool descriptions. |
| `MAX_CHUNKS` | `10000` | Max chunk count before oldest chunks are evicted. |
| `SF_INGEST_ROOTS` | unset | Colon-separated absolute paths the ingest tools may read from, in addition to the working directory. Security boundary — see [Security: ingest-root allowlist](#security-ingest-root-allowlist). |

## Security: ingest-root allowlist

The ingest entry points (`ingest_project`, `ingest_directory`, and the `ingest` /
`ingest-project` CLI commands) only read from an explicit set of **allowed roots**.
This prevents an agent (or injected context) from ingesting arbitrary absolute
paths such as `~/.ssh` or `/etc`.

Allowed roots:

1. The process working directory (always — the frictionless local default is
   "ingest the repo you launched from").
2. Any colon-separated path in `SF_INGEST_ROOTS` (relative entries resolve against
   the working directory).

The check resolves symlinks (`realpath`) and rejects `..` traversal, so a link or
relative path that escapes every root is still refused. To index a directory
outside the working tree, add it explicitly:

```sh
export SF_INGEST_ROOTS=/path/to/other/repo
```

Denials exit non-zero (CLI, exit code 2) or return an `isError` response naming the
allowed roots (MCP). The orchestrator itself remains a trusted internal API and is
not re-checked by this boundary.

## Embedding Providers

> **Highest-quality local-first path:** set `EMBEDDING_PROVIDER=gpu` with the default
> code-specific model (`Salesforce/SFR-Embedding-Code-400M_R`). It runs locally via a
> Python `sentence-transformers` sidecar — on CUDA when available, or on CPU with
> `GPU_EMBEDDING_DEVICE=cpu` (the default code model is small enough to be CPU-feasible).
> The `local` provider's `Xenova/bge-small-en-v1.5` is the lightweight, in-process ONNX
> fallback (general English, no Python required) used when you want zero extra
> dependencies.
>
> **Regime dependence (read before citing benchmark numbers):** the published
> retrieval claim — the `structural` hybrid is competitive on recall and beats FTS
> on top-1 (Hits@1) — holds **only on the `gpu` provider with the SFR code model**.
> The frictionless `local` `bge` default gives working retrieval but is a *weaker
> regime*: trusting its vector arm at the calibrated fusion weights actually *lowers*
> top-1, and the acceptance gate fails on it. To reproduce the published numbers,
> use `EMBEDDING_PROVIDER=gpu` (CPU is fine). See
> [`benchmarks/MODEL-VERIFICATION.md`](../benchmarks/MODEL-VERIFICATION.md),
> [`benchmarks/FROZEN-CLAIM.md`](../benchmarks/FROZEN-CLAIM.md), and
> [`benchmarks/GPU-REPRODUCTION.md`](../benchmarks/GPU-REPRODUCTION.md).

### Local Embeddings

Local (transformers.js) embeddings are the zero-dependency default. They run in-process
with ONNX models and do not require cloud access or Python. `Xenova/bge-small-en-v1.5`
is a lightweight, general-English model — prefer the `gpu` provider with the code-specific
default for the highest retrieval quality on code.

```bash
EMBEDDING_PROVIDER=local
EMBEDDING_MODEL=Xenova/bge-small-en-v1.5
node dist/main.js download-model
node dist/main.js serve
```

Common local models:

| Model | Approximate size | Use |
| --- | ---: | --- |
| `Xenova/bge-small-en-v1.5` | 130 MB | Default local model. |
| `Xenova/all-MiniLM-L6-v2` | 80 MB | Smaller and faster. |
| `Xenova/gte-small` | 130 MB | General-purpose alternative. |

### GPU / Sidecar Embeddings (recommended high-quality path)

The `gpu` provider uses a Python subprocess and `sentence-transformers`. It is the
recommended high-quality path and defaults to a code-specific model,
`Salesforce/SFR-Embedding-Code-400M_R` (open weights, strong on code retrieval). The
model runs locally — no cloud access — on GPU or CPU.

```bash
pip install sentence-transformers torch
# GPU:
EMBEDDING_PROVIDER=gpu \
GPU_EMBEDDING_MODEL=Salesforce/SFR-Embedding-Code-400M_R \
GPU_EMBEDDING_DEVICE=cuda \
node dist/main.js serve

# CPU-only (no GPU required; the default code model is small enough to be CPU-feasible):
EMBEDDING_PROVIDER=gpu \
GPU_EMBEDDING_DEVICE=cpu \
node dist/main.js serve
```

The subprocess communicates with the Node process over JSON-RPC on stdin/stdout. The
first run downloads the model into the HuggingFace cache (multi-hundred-MB), so it is
not used in CI/tests — the deterministic provider is used there instead.

### Deterministic Fallback

```bash
EMBEDDING_PROVIDER=deterministic
node dist/main.js serve
```

This mode uses deterministic hash-based vectors. It is useful for offline bootstrapping, but retrieval quality is much lower than real embeddings.

## Embedding Backfill

Run backfill after switching embedding providers or models:

```bash
node dist/main.js backfill-embeddings
EMBEDDING_PROVIDER=local node dist/main.js backfill-embeddings --model Xenova/bge-small-en-v1.5
```

Embeddings are persisted in `chunk_embeddings`. The vector index is a derived cache that can be rebuilt from stored embeddings.

## Compression Providers

### Deterministic Compression

```bash
COMPRESSION_PROVIDER=deterministic
node dist/main.js serve
```

This is the default. It extracts constraints, facts, and code signatures without model calls.

### Local Compression

```bash
COMPRESSION_PROVIDER=local
COMPRESSION_MODEL=Xenova/bge-small-en-v1.5
node dist/main.js serve
```

Local compression uses the configured local model when available and falls back to deterministic behavior when needed.

### LLM Compression

Use any OpenAI-compatible chat completions endpoint:

```bash
COMPRESSION_PROVIDER=llm \
LLM_COMPRESSION_ENDPOINT=https://api.openai.com/v1/chat/completions \
LLM_COMPRESSION_API_KEY=sk-... \
LLM_COMPRESSION_MODEL=gpt-4o-mini \
node dist/main.js serve
```

If required LLM settings are missing or the API call fails, Spacefolding falls back to deterministic compression.

### LLMLingua Compression

```bash
pip install llmlingua
COMPRESSION_PROVIDER=llmlingua \
LLMLINGUA_MODEL=microsoft/llmlingua-2-xlm-roberta-large-meetingbank \
LLMLINGUA_RATE=0.5 \
node dist/main.js serve
```

LLMLingua is optional and only needed for token-level compression experiments.

## Retrieval Defaults

`retrieve_context` and CLI `retrieve` use adaptive planning when the caller does not specify a strategy or token budget.

| Setting | Default behavior |
| --- | --- |
| Mode | `focused` |
| Strategies | `structural`, `hybrid`, `vector`, `text`, or `graph` |
| Focused targets | 6k narrow, 13k moderate, 18k broad |
| Broad targets | 16k narrow, 28k moderate, 40k broad |
| Exhaustive target | Caller hard budget |
| Graph hops | `0` unless `strategy` is `graph` or `maxHops` is provided |

See [retrieval pipeline](./concepts/retrieval-pipeline.md) for the full selection model.

## Chunking

```bash
CHUNK_MAX_TOKENS=2000
CHUNK_OVERLAP_TOKENS=200
CHUNK_STRATEGY=auto
CHUNK_TREE_SITTER=1
```

| Strategy | Behavior |
| --- | --- |
| `auto` | Detect code, Markdown, or plain text. |
| `code` | Split at code-oriented boundaries; can use tree-sitter when enabled. |
| `markdown` | Split at heading boundaries. |
| `recursive` | Split by paragraph, sentence, then words. |

## Web UI

The web UI starts with the MCP server when `WEB_PORT` is greater than `0`.

```bash
WEB_PORT=8080 WEB_HOST=127.0.0.1 node dist/main.js serve
```

Docker exposes the web UI with:

```bash
WEB_PORT=8080
WEB_HOST=0.0.0.0
```

Then open `http://127.0.0.1:8080`.

## MCP Transport

Default stdio transport:

```bash
TRANSPORT=stdio node dist/main.js serve
```

SSE transport:

```bash
TRANSPORT=sse PORT=3000 node dist/main.js serve
```

Use stdio for Claude Code local tool integration. Use SSE when a client needs HTTP transport.

## Routing Weights

Routing weights can be tuned through `config.example.json`:

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

| Weight | Meaning |
| --- | --- |
| `semantic` | Similarity to the current task. |
| `constraint` | Priority boost for hard requirements and instructions. |
| `recency` | Freshness boost with decay. |
| `redundancy` | Penalty for repeated information. |
| `dependency` | Boost for chunks linked to important context. |

The hot tier is capped to prevent runaway promotion.

## Docker Compose

The included Compose file persists data and model cache under `./data`:

```yaml
services:
  spacefolding:
    build: .
    volumes:
      - ./data:/app/data
      - ./workspace:/workspace:ro
    ports:
      - "3000:3000"
      - "8080:8080"
    environment:
      - DB_PATH=/app/data/spacefolding.db
      - MODEL_PATH=/app/data/models
      - EMBEDDING_PROVIDER=local
      - WEB_PORT=8080
      - WEB_HOST=0.0.0.0
```

## See Also

- [Quick-start tutorial](./tutorials/quick-start.md)
- [CLI reference](./reference/cli.md)
- [Claude Code integration](./integration-guide.md)
