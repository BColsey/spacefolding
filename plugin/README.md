# Spacefolding — Claude Code Plugin

> **Local codebase context engine for coding agents.** Fold infinite context space into what fits in your prompt window.

This plugin wires the [Spacefolding](https://github.com/BColsey/spacefolding) MCP server into Claude Code via hooks, so your repo is **indexed automatically** and the index is **kept fresh** as you edit — with zero manual tool calls.

The MCP server is the **engine** (ingest / score / retrieve / re-index). This plugin is the **interface** — the hooks that drive it from a real session.

## What it does

- **SessionStart** (`startup|resume|clear`): on a fresh session, auto-indexes the project (or notes freshness if already indexed) and injects a small context pack pointing you at `retrieve_context`.
- **PostToolUse** (`Edit|Write`): re-indexes the one edited file within seconds via Spacefolding's chunk-preserving re-ingest. Chunk keys stay aligned with the watcher, so edits update in place.
- **PreCompact** (`manual|auto`): re-injects an index-state note after compaction, so awareness survives.
- **Skill** (`retrieve-context`): teaches Claude when to pull task context from the index instead of grepping.

## Prerequisites

1. **Node.js 18+** (for `npx`).
2. **Run `spacefolding init` once in the project** — this writes the `.mcp.json` entry that connects the Spacefolding MCP server to Claude Code and pre-warms the embedding model:
   ```bash
   npx -y spacefolding init
   ```
   (If `EMBEDDING_PROVIDER` is the default `local`, the first run downloads the embedding model (~100MB) once.)

## Install

### From the marketplace (published)

```
/plugin marketplace add BColsey/spacefolding
/plugin install spacefolding
```

### From a local checkout

If you're developing Spacefolding itself:

```
/plugin install /absolute/path/to/spacefolding/plugin
```

## Security model — `SF_INGEST_ROOTS`

Spacefolding **never** indexes paths outside an explicit allowlist. This is the trust boundary, enforced by every hook:

- The process working directory (cwd) is **always** allowed — the frictionless local default is "index the repo you launched from."
- Add more roots with the `SF_INGEST_ROOTS` environment variable (colon-separated, relative entries resolve against cwd):
  ```bash
  export SF_INGEST_ROOTS="/Users/me/monorepo:/Users/me/shared-libs"
  ```

A `PostToolUse` edit to a file outside the roots is logged and **skipped** — it never reaches the index. Symlinks are never followed. `node_modules`, `.git`, and `dist` are always ignored, along with binary file extensions and your `.gitignore` patterns.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `DB_PATH` | `./data/spacefolding.db` | Per-project SQLite index location |
| `SF_INGEST_ROOTS` | (cwd only) | Additional allowed ingest roots |
| `SF_SESSION_START_MAX_FILES` | `20000` | Above this, SessionStart skips bulk auto-index |
| `EMBEDDING_PROVIDER` | `local` | `local` (default, deterministic-ish) \| `deterministic` \| `gpu` |

See the [full configuration guide](https://github.com/BColsey/spacefolding/blob/main/docs/configuration.md).

## How retrieval works

The `retrieve-context` skill defaults to **task-scoped** retrieval:

```
get_context_for_task("fix the off-by-one in the budget allocator")
```

This plans the query, runs **hybrid retrieval** (vector + FTS5 + graph), scores chunks against your task, and returns a token-budgeted context pack. For an explicit query, use `retrieve_context({ query: "..." })` directly.

## License

SEE LICENSE IN [LICENSE](https://github.com/BColsey/spacefolding/blob/main/LICENSE).
