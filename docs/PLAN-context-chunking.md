# Plan: Oversized Context Splitting (Context Chunker)

## Problem

Spacefolding currently ingests text/files as single chunks regardless of size. If a user
passes a 500K-token file, it becomes one massive chunk that:
- Exceeds any LLM context window for compression
- Can't be meaningfully scored (one score for the entire thing)
- Can't be partially routed (all hot or all cold)

The system needs a **ContextChunker** — a pre-ingestion splitting layer that breaks oversized
input into semantically coherent sub-chunks **before** the LLM ever sees them.

## Research Findings

### Established Approaches (from LangChain, LlamaIndex, academic work)

1. **Recursive Character Text Splitting** — Split on `\n\n`, then `\n`, then `. `, then ` `
   with configurable chunk_size and overlap. Works for prose. LangChain's default.

2. **Sentence Splitting** — Split at sentence boundaries. Better for semantic coherence.
   LlamaIndex's `SentenceSplitter` does this with configurable overlap.

3. **Code-Aware Splitting (AST)** — Split source code at function/class boundaries.
   LlamaIndex's `CodeSplitter` uses tree-sitter. We can approximate with regex on
   our existing `symbol-extractor.ts` patterns.

4. **Markdown Structure Splitting** — Split on `##` headers, preserving hierarchy.
   LlamaIndex's `MarkdownNodeParser`.

5. **Semantic Splitting** — Embed consecutive sentences, split where embedding similarity
   drops below a threshold. Greg Kamradt's approach. Requires embedding model.

6. **Hierarchical Splitting** — Create chunks at multiple granularities (2048, 512, 128)
   with parent-child links. LlamaIndex's `HierarchicalNodeParser`.

### What fits Spacefolding

Our system already has:
- `parentId` / `childrenIds` fields on `ContextChunk` (unused)
- `symbol-extractor.ts` for code-aware boundaries
- `TokenEstimator` for size measurement
- `EmbeddingProvider` for semantic splitting
- `ContextChunk.type` for format-aware strategies

## Architecture

```
INPUT (oversized text/file)
         │
         ▼
┌─────────────────────┐
│  CONTEXT  CHUNKER   │
│                     │
│  1. Measure tokens  │
│  2. Detect format   │
│  3. Pick strategy   │
│  4. Split           │
│  5. Link parent/    │
│     children        │
└────────┬────────────┘
         │
    ┌────┴────┐
    ▼         ▼
  Chunk[]   Parent Chunk (metadata only)
    │
    ▼
  NORMAL PIPELINE (score → route → compress)
```

### New File: `src/core/chunker.ts`

A `ContextChunker` class with pluggable splitting strategies:

```typescript
interface ChunkingStrategy {
  split(text: string, maxTokens: number): string[];
}
```

### Strategies (in priority order for implementation)

#### 1. `RecursiveTextChunker` (universal baseline)
- Split on paragraph breaks (`\n\n`), then line breaks (`\n`), then sentences (`. `), then spaces
- Configurable `maxTokens` (default: 2000) and `overlap` (default: 200 tokens)
- Fallback for any content type

#### 2. `CodeChunker` (source files)
- Detect language from file extension
- Split at function/class/interface boundaries using existing regex patterns from `symbol-extractor.ts`
- Keep imports/exports attached to the first chunk
- Preserve indentation context
- If no structural boundaries found, fall back to RecursiveTextChunker

#### 3. `MarkdownChunker` (documentation)
- Split on `##` and `###` headers
- Each section becomes a chunk with the header preserved
- Frontmatter stays with the first chunk
- Code blocks within sections stay intact

#### 4. `SemanticChunker` (requires embedding model)
- Split text into sentences
- Embed consecutive sentences
- Find natural "breakpoints" where similarity drops below threshold
- Falls back to RecursiveTextChunker if no embedding model available

### Token Budget Configuration

New env vars:
- `CHUNK_MAX_TOKENS` (default: 2000) — Maximum tokens per sub-chunk
- `CHUNK_OVERLAP_TOKENS` (default: 200) — Overlap between consecutive chunks
- `CHUNK_STRATEGY` (default: `auto`) — `auto`, `recursive`, `code`, `markdown`, `semantic`

`auto` picks the best strategy based on content type detection:
- `.ts/.js/.py/.rs/.go/.java` → CodeChunker
- `.md` → MarkdownChunker
- Has embedding model + `semantic` → SemanticChunker
- Everything else → RecursiveTextChunker

### Parent-Child Linking

When a chunk is split:
1. Original chunk is stored as a **parent** with `text` set to a metadata summary (first line + source info)
2. Each split piece becomes a **child** chunk with `parentId = parent.id`
3. Parent's `childrenIds` is populated with all child IDs
4. Dependency links of type `contains` are created between parent → children
5. Children inherit `source`, `type`, `path`, `language` from parent

### Integration Points

1. **`ContextIngester`** — Auto-chunk before creating the chunk if `tokensEstimate > CHUNK_MAX_TOKENS`
2. **`MCP tool: ingest_context`** — Transparent; caller sends large text, gets back the parent chunk ID
3. **`CLI: ingest`** — Transparent; file gets split automatically
4. **`CLI: score`** — Children are scored independently; parent gets the max child score
5. **`PipelineOrchestrator`** — When compressing warm chunks, collapse siblings back together if they share a parent

## Implementation Tasks (ordered)

### Phase 1: Core Chunker + Recursive Strategy
1. Create `src/core/chunker.ts` with `ContextChunker`, `ChunkingStrategy` interface, and `RecursiveTextChunker`
2. Update `ContextIngester` to auto-chunk oversized input, creating parent-child links
3. Update `PipelineOrchestrator.processContext` to handle parent-child scoring inheritance
4. Add `CHUNK_MAX_TOKENS`, `CHUNK_OVERLAP_TOKENS`, `CHUNK_STRATEGY` env vars
5. Tests for recursive splitting logic

### Phase 2: Code-Aware Chunker
6. Create `CodeChunker` using symbol boundary detection from `symbol-extractor.ts`
7. Import hoisting logic (keep `import`/`require` at top of first chunk)
8. Tests for code splitting across function boundaries

### Phase 3: Markdown Chunker
9. Create `MarkdownChunker` with header-based splitting
10. Tests for markdown splitting

### Phase 4: Semantic Chunker (optional, needs embeddings)
11. Create `SemanticChunker` using embedding similarity breakpoints
12. Fallback to recursive when no embedding model available
13. Tests for semantic splitting

### Phase 5: Pipeline Integration
14. Update MCP `ingest_context` tool to return parent chunk ID when splitting occurs
15. Update CLI `ingest` to show split counts
16. Update Web UI to display parent-child relationships
17. Update `compress_context` to optionally collapse siblings

### Phase 6: Docs
18. Update README.md with chunking section
19. Update docs/configuration.md with new env vars
20. Update CLAUDE.md with chunking behavior

## File Changes Summary

| File | Change |
|------|--------|
| `src/core/chunker.ts` | **NEW** — ContextChunker, ChunkingStrategy, RecursiveTextChunker |
| `src/core/code-chunker.ts` | **NEW** — CodeChunker |
| `src/core/markdown-chunker.ts` | **NEW** — MarkdownChunker |
| `src/core/semantic-chunker.ts` | **NEW** — SemanticChunker (optional) |
| `src/core/ingester.ts` | MODIFY — Auto-chunk oversized input |
| `src/pipeline/orchestrator.ts` | MODIFY — Parent-child scoring inheritance |
| `src/mcp/server.ts` | MODIFY — Return split info on ingest |
| `src/cli/index.ts` | MODIFY — Show split counts on ingest |
| `src/types/index.ts` | MODIFY — Add ChunkingConfig interface |
| `.env.example` | MODIFY — Add CHUNK_* vars |
| `README.md` | MODIFY — Add chunking section |
| `docs/configuration.md` | MODIFY — Add chunking config |

## Key Design Decisions

1. **Splitting happens at ingestion time, not at query time** — This way chunks are already scored/routed individually and the pipeline doesn't need to change.

2. **Parent chunks are metadata-only** — They don't contain the full text. They serve as grouping anchors for dependency tracking and sibling collapse.

3. **Children are independent citizens** — They get their own scores, tiers, and routing. This is the whole point: different parts of a large file may end up in different tiers.

4. **Overlap prevents context loss at boundaries** — 200 tokens of overlap means no information is lost at split points. The overlap is accounted for in token budgets.

5. **Code splitting respects AST boundaries** — Functions and classes are kept intact. Only when a single function exceeds `CHUNK_MAX_TOKENS` do we fall back to line-based splitting within it.

6. **Deterministic fallback always works** — RecursiveTextChunker requires no models, no network. It's always available as the baseline strategy.
