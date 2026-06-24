---
name: retrieve-context
description: Use before editing unfamiliar code, when you need to find the right files/symbols/snippets for a task, when tracing a bug across modules, or when the relevant context is scattered. Searches the Spacefolding index (semantic + lexical + structural) and returns only what fits the token budget.
---

# Retrieve context from the Spacefolding index

Spacefolding has already indexed this repo (the SessionStart hook ran on session
start, and the PostToolUse hook keeps the index fresh as files are edited). Use
it instead of grepping blindly or re-reading whole files.

## When to call

Call this skill **before** you edit code when any of these are true:

- You're about to edit unfamiliar code and need to see the surrounding context.
- You're tracing a bug or feature across multiple files/modules.
- The relevant snippets are scattered and you only want the parts that matter.
- A grep would return too much (you want the token-budgeted, ranked subset).

## How to call

**Default — task-scoped retrieval:**

```
get_context_for_task("<what you're trying to do>")
```

This plans the query, retrieves hybrid (vector + FTS5 + graph), scores against
your task, and returns a context pack sized to the token budget. Pass it a plain
description of the task (e.g. "fix the off-by-one in the budget allocator").

**Explicit retrieval (when you have a specific query):**

```
retrieve_context({ query: "<search terms>" })
```

Use this when you want raw ranked results for a precise query rather than a
task-scoped pack.

## If the index is empty

If retrieval returns nothing or the session-start note said the index is empty,
the project was likely too large for auto-index (or outside `SF_INGEST_ROOTS`).
Run:

```
spacefolding ingest-project .
```

then retry. The index refreshes on the next file edit automatically.

## Security note

Spacefolding only indexes paths inside `SF_INGEST_ROOTS` (cwd is always allowed).
Files outside the roots are never indexed or re-indexed — this is the trust
boundary, enforced by every hook.
