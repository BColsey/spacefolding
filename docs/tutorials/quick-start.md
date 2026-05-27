---
title: Quick-Start Tutorial
description: Install Spacefolding, ingest a project, and retrieve focused context.
last_updated: 2026-05-27
review_schedule: quarterly
owner: maintainers
doc_type: tutorial
---

# Quick-Start Tutorial

This tutorial gets Spacefolding running, indexes a project, and retrieves context for a coding task.

## What You Will Do

1. Start Spacefolding with Docker or local Node.js.
2. Download the default local embedding model.
3. Ingest the current project.
4. Retrieve focused context.
5. Inspect the running service.

## Prerequisites

- Docker with Compose, or Node.js with npm.
- A checkout of this repository.

## Option A: Docker

Clone and start the service:

```bash
git clone https://github.com/BColsey/spacefolding.git
cd spacefolding
cp .env.example .env
docker compose up --build
```

In another shell, verify the service:

```bash
docker compose exec spacefolding node dist/main.js health
```

Expected shape:

```json
{"status":"ok","chunks":0}
```

Download the default embedding model inside the container:

```bash
docker compose exec spacefolding node dist/main.js download-model
```

## Option B: Local Node.js

Install dependencies and build:

```bash
npm install
npm run build
```

Download the default embedding model:

```bash
node dist/main.js download-model
```

Check the local database:

```bash
node dist/main.js health
```

Expected shape:

```json
{"status":"ok","chunks":0}
```

## Ingest a Project

Use `ingest-project` for a codebase. It includes source, README files, docs, `.env.example`, common config files, and agent instruction files. Tests and benchmarks are skipped unless requested.

```bash
node dist/main.js ingest-project .
```

The output includes file counts, context file counts, chunk counts, and skipped files.

## Retrieve Focused Context

Ask a task-shaped question:

```bash
node dist/main.js retrieve \
  --query "how does routing decide hot warm and cold context" \
  --mode focused
```

Expected shape:

```text
Query: how does routing decide hot warm and cold context
Intent: explain | Strategy: structural | Mode: focused | Tokens: ...

[WARM] ...
```

Use `--mode broad` when the task is ambiguous and `--mode exhaustive` when you want raw inspection up to the hard token limit.

## Enable the Web UI

Set `WEB_PORT` before serving:

```bash
WEB_PORT=8080 node dist/main.js serve
```

Open `http://127.0.0.1:8080` to inspect chunks and routing state.

## Connect Claude Code

Once Spacefolding runs locally, configure it as an MCP server:

- [Claude Code integration](../integration-guide.md)
- [MCP tools reference](../reference/mcp-tools.md)

## Next Steps

- Read [how Spacefolding works](../concepts/how-spacefolding-works.md).
- Look up commands in the [CLI reference](../reference/cli.md).
- Tune providers in the [configuration reference](../configuration.md).
