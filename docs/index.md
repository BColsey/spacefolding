---
title: Documentation Index
description: A task-oriented map of Spacefolding documentation.
last_updated: 2026-05-29
review_schedule: quarterly
owner: maintainers
doc_type: reference
---

# Documentation Index

> **The local-first context-engineering engine for coding agents.**

Start here when you know what you want to do but not which file has the answer.

## Choose a Path

| Goal | Read |
| --- | --- |
| Install and try Spacefolding. | [Quick-start tutorial](./tutorials/quick-start.md) |
| Understand when Spacefolding is useful. | [Why Spacefolding](./concepts/why-spacefolding.md) |
| Understand hot/warm/cold routing. | [How Spacefolding works](./concepts/how-spacefolding-works.md) |
| Understand focused retrieval. | [Retrieval pipeline](./concepts/retrieval-pipeline.md) |
| Connect Claude Code. | [Claude Code integration](./integration-guide.md) |
| Look up CLI commands. | [CLI reference](./reference/cli.md) |
| Look up MCP tools. | [MCP tools reference](./reference/mcp-tools.md) |
| Tune environment variables. | [Configuration reference](./configuration.md) |
| Review the code layout. | [Architecture reference](./reference/architecture.md) |
| Run quality and benchmark gates. | [Run benchmarks](./howto/run-benchmarks.md) |

## Documentation Sets

### Tutorials

- [Quick-start tutorial](./tutorials/quick-start.md) - Install, ingest a project, retrieve context, and inspect state.

### How-To Guides

- [Claude Code integration](./integration-guide.md) - Configure Spacefolding as an MCP server for Claude Code.
- [Run benchmarks](./howto/run-benchmarks.md) - Build, test, and run retrieval acceptance checks.

### Reference

- [CLI reference](./reference/cli.md) - Commands, options, and examples.
- [MCP tools reference](./reference/mcp-tools.md) - Tool names, inputs, and common call patterns.
- [Configuration reference](./configuration.md) - Environment variables, providers, routing weights, Docker, and web UI.
- [Architecture reference](./reference/architecture.md) - Source tree, runtime surfaces, and persistence components.

### Concepts

- [Why Spacefolding](./concepts/why-spacefolding.md) - Audience, search comparison, benchmark meaning, and current proof boundaries.
- [How Spacefolding works](./concepts/how-spacefolding-works.md) - Context lifecycle, routing tiers, scoring, and storage.
- [Retrieval pipeline](./concepts/retrieval-pipeline.md) - Query planning, strategies, modes, and token budgets.

## Benchmark Snapshots

Benchmark result snapshots live under `benchmarks/` because they are point-in-time measurements rather than long-lived docs:

- [Ranking results](../benchmarks/RESULTS.md)
- [Focused retrieval E2E results](../benchmarks/E2E-RESULTS.md)
- [Acceptance gate](../benchmarks/ACCEPTANCE.md)
- [Held-out datasets](../benchmarks/HELDOUT.md)
- [Large repository held-out snapshot](../benchmarks/LARGE-REPO-HELDOUT.md)
- [Model comparison](../benchmarks/MODEL-COMPARISON.md)
- [Ablation study](../benchmarks/ABLATION.md)
- [GPU ablation](../benchmarks/ABLATION-GPU.md)
- [Real embeddings ablation](../benchmarks/ABLATION-REAL-EMBEDDINGS.md)
- [Academic comparison](../benchmarks/ACADEMIC-COMPARISON.md)
