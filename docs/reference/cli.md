---
title: CLI Reference
description: Command-line reference for running, ingesting, retrieving, exporting, and inspecting Spacefolding context.
last_updated: 2026-05-27
review_schedule: quarterly
owner: maintainers
doc_type: reference
---

# CLI Reference

Run commands through the built entrypoint:

```bash
node dist/main.js <command>
```

After package installation, the binary name is `spacefolding`.

## Global Option

| Option | Default | Description |
| --- | --- | --- |
| `--db <path>` | `DB_PATH` or `./data/spacefolding.db` | SQLite database path. |

## Commands

| Command | Purpose |
| --- | --- |
| `serve` | Start the MCP server. This is also the default command. |
| `health` | Print JSON health status and chunk count. |
| `ingest <path>` | Ingest one file or a directory tree. |
| `ingest-project <path>` | Ingest source plus README/docs, env examples, config, and agent instructions. |
| `watch <path>` | Watch a path and ingest file changes. |
| `score --task <text>` | Score all context for a task and print hot/warm/cold tiers. |
| `retrieve --query <text>` | Retrieve focused task context. |
| `explain --task <text>` | Explain routing decisions. |
| `graph --chunk <id>` | Inspect dependencies for one chunk. |
| `symbols <path>` | Extract source symbols from a file. |
| `export <output-path>` | Export memory state to JSON. |
| `import <input-path>` | Import memory state from JSON. |
| `download-model` | Download a local embedding model. |
| `backfill-embeddings` | Embed chunks missing embeddings for the active model. |

## serve

```bash
node dist/main.js serve --transport stdio
node dist/main.js serve --transport sse --port 3000
```

| Option | Default | Description |
| --- | --- | --- |
| `--transport <type>` | `TRANSPORT` or `stdio` | `stdio` or `sse`. |
| `--port <number>` | `PORT` or `3000` | SSE transport port. |

Set `WEB_PORT` to start the web UI alongside the MCP server.

## ingest

```bash
node dist/main.js ingest README.md
node dist/main.js ingest src --type code
```

| Option | Default | Description |
| --- | --- | --- |
| `--source <source>` | `file` | Source label for ingested chunks. |
| `--type <type>` | Auto-detected | Chunk type override. |

## ingest-project

```bash
node dist/main.js ingest-project .
node dist/main.js ingest-project . --include-tests --include-benchmarks
node dist/main.js ingest-project . --no-docs
```

| Option | Default | Description |
| --- | --- | --- |
| `--no-docs` | Docs included | Skip README files and `docs/**/*.md`. |
| `--include-tests` | `false` | Include tests and specs. |
| `--include-benchmarks` | `false` | Include benchmark directories. |

## retrieve

```bash
node dist/main.js retrieve --query "how does routing work"
node dist/main.js retrieve --query "where is ContextRouter" --strategy structural --mode focused
node dist/main.js retrieve --query "all retrieval budget behavior" --mode broad --max-tokens 50000
```

| Option | Default | Description |
| --- | --- | --- |
| `--query <text>` | Required | Task-shaped retrieval query. |
| `--max-tokens <number>` | Adaptive | Hard result budget. |
| `--strategy <type>` | Adaptive | `structural`, `hybrid`, `vector`, `text`, or `graph`. |
| `--mode <type>` | `focused` | `focused`, `broad`, or `exhaustive`. |
| `--top-k <number>` | Adaptive | Retrieval candidates before selection. |
| `--return-limit <number>` | `top-k` | Candidates considered before budget fill. |
| `--max-hops <number>` | Strategy-dependent | Graph traversal hops. |

See [retrieval pipeline](../concepts/retrieval-pipeline.md) for strategy and mode behavior.

## score

```bash
node dist/main.js score --task "fix retrieval budget overflow"
```

The command prints chunk IDs grouped by hot, warm, and cold tier with scores.

## explain

```bash
node dist/main.js explain --task "fix retrieval budget overflow"
node dist/main.js explain --task "fix retrieval budget overflow" --chunk <chunk-id>
```

Use this after scoring when you need the reasons behind a tier assignment.

## graph

```bash
node dist/main.js graph --chunk <chunk-id>
```

The command prints incoming and outgoing dependency links for a chunk.

## symbols

```bash
node dist/main.js symbols src/core/router.ts
```

Supported language detection includes TypeScript, JavaScript, Python, Rust, Go, and Java file extensions.

## export And import

```bash
node dist/main.js export /tmp/spacefolding-state.json
node dist/main.js import /tmp/spacefolding-state.json
```

Generated exports can be large. Keep scratch exports under `/tmp` unless they are intentionally versioned fixtures.

## download-model

```bash
node dist/main.js download-model
node dist/main.js download-model --model Xenova/all-MiniLM-L6-v2
```

The default model is `Xenova/bge-small-en-v1.5`.

## backfill-embeddings

```bash
node dist/main.js backfill-embeddings
node dist/main.js backfill-embeddings --model Xenova/bge-small-en-v1.5 --batch-size 25
```

Run this after switching embedding providers or models, or after ingesting chunks before embeddings were available.
