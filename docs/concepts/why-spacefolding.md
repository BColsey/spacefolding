---
title: Why Spacefolding
description: Explanation of who Spacefolding is for, what it adds beyond search, and how to read its benchmarks.
last_updated: 2026-05-29
review_schedule: quarterly
owner: maintainers
doc_type: explanation
---

# Why Spacefolding

Spacefolding is for developers and coding agents working in repositories or
sessions that are too large to carry in a prompt. It is most useful when the
task is specific, the relevant code may be spread across files, and the agent
needs a compact bundle of source, docs, constraints, or logs before it edits.

It is not a replacement for direct search. If you know the exact identifier,
error string, or file path, `grep`, full-text search, and symbol search should
still be the first move. Spacefolding is for the next step: turning a task into
ranked, prompt-ready context when one signal is not enough.

## Who It Is For

| Reader | Spacefolding helps when |
| --- | --- |
| Agent users | A coding agent needs likely files and constraints before making a change. |
| Maintainers | A large repository has repeated tasks where keyword search returns too much or too little. |
| Tool builders | An MCP client needs local retrieval over source, docs, logs, and session context. |
| Reviewers | A change needs supporting context without reading the whole codebase first. |

Small repositories, one-file edits, and exact-match lookups usually do not need
Spacefolding. Plain search is simpler and faster when the answer is already
obvious.

## What It Adds Beyond Search

Grep, FTS, and symbol search each answer one kind of question. Spacefolding
combines those signals and then selects context that fits the task budget.

| Search alone | What Spacefolding adds |
| --- | --- |
| Grep finds exact words. | Task planning, query expansion, and scoring for code that uses different words than the request. |
| FTS ranks lexical matches. | Blending with paths, symbols, references, vectors, and dependencies. |
| Symbol search finds definitions. | Related implementations, call sites, docs, and chunks that explain how the symbol is used. |
| Search returns candidate lists. | Prompt-sized context bundles with selected chunks, source metadata, and dropped-candidate reasons. |
| Search sees the current index. | Hot/warm/cold routing for exact active context, compressed useful context, and archived searchable context. |

The practical goal is not to replace a developer's judgment. The goal is to put
better first-pass context in front of an agent so it starts from the right part
of the codebase more often.

## How To Read The Benchmarks

The ranking benchmarks ask a plain question: when a task depends on a source
file, does retrieval put that file in the first pile an agent would inspect?

Read the metrics as behavior, not as abstract scores:

| Benchmark signal | Non-metric meaning |
| --- | --- |
| Recall near the top | The needed file is likely to be present before the agent reads deeply. |
| Rank quality | The needed file is not just present; it appears early enough to influence the agent. |
| Keyword baseline comparison | Spacefolding is only useful if its combined strategy beats grep-like search on tasks where search alone is weak. |
| Focused retrieval checks | The returned bundle should contain the important context without flooding the prompt. |
| Held-out repositories | The system is tested on code outside this project, reducing the chance that results only fit Spacefolding's own codebase. |

Benchmarks are a retrieval signal. They show whether Spacefolding can put
expected context near the front of the queue. They do not prove that an agent
will make the correct edit, write the right design, or avoid every missed
dependency.

## Where It Is Not Yet Proven

Spacefolding has useful evidence, but the evidence has boundaries:

- Generated held-out tasks are a first signal, not a replacement for expert
  task suites on unfamiliar repositories.
- Finding the expected file does not prove end-to-end agent success on bug
  fixes, feature work, migrations, or reviews.
- Very large repositories can require more CPU, memory, worker tuning, and
  benchmark-specific chunk limits than a small laptop should use by default.
- Runtime behavior, generated code, build-system state, and external services
  still need normal tests, logs, and developer inspection.
- Language support depends on the available symbol extraction and indexing
  quality for that repository.
- Provider quality can vary. Local deterministic behavior, local embeddings,
  GPU embeddings, and LLM compression are not interchangeable guarantees.

Use Spacefolding as a context engine: it improves the odds that the right
material reaches the prompt, while tests, review, and targeted search remain
part of the engineering loop.

## See Also

- [How Spacefolding works](./how-spacefolding-works.md)
- [Retrieval pipeline](./retrieval-pipeline.md)
- [Run benchmarks](../howto/run-benchmarks.md)
