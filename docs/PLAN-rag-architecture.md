# Plan: Full RAG Architecture for Spacefolding

## What Spacefolding Already Has

Before designing what's missing, here's what the system already does:

```
✅ Embedding generation (local ONNX + deterministic fallback)
✅ Scoring (multi-factor: semantic, constraint, recency, redundancy, dependency)
✅ Routing (hot/warm/cold tier assignment)
✅ Compression (deterministic, local ONNX, LLM API)
✅ Storage (SQLite with full CRUD)
✅ Dependency graph (chunk-to-chunk relationships)
✅ Keyword reranking (DeterministicRerankerProvider)
✅ MCP tools for agent integration
✅ Token estimation
✅ Symbol extraction (regex-based code parsing)
```

## What's Missing for a Complete RAG System

The system currently operates as a **push model**: you ingest context, score it against a
task, and get routing back. A true RAG system also needs a **pull model**: given a query,
actively retrieve the best context from storage.

Here are the gaps:

```
❌ Vector index — embeddings are computed on-the-fly, never stored or indexed
❌ ANN search — no approximate nearest neighbor lookup for fast retrieval
❌ Query expansion — no query rewriting or decomposition
❌ Hybrid search — no combination of vector + keyword + graph search
❌ Context window budgeting — no "fill to N tokens" retrieval
❌ Multi-hop retrieval — no following dependency chains across hops
❌ Re-ranking pipeline — reranker exists but isn't wired into retrieval
❌ Result fusion — no combining results from multiple retrieval strategies
```

## Architecture: The Full Picture

```
                              USER QUERY
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │     QUERY PLANNER      │
                    │                        │
                    │  1. Analyze query      │
                    │  2. Detect intent      │
                    │  3. Expand/rewrite     │
                    │  4. Set token budget   │
                    └────────────┬───────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                   │
    ┌─────────▼──────┐  ┌───────▼────────┐  ┌──────▼──────────┐
    │  VECTOR SEARCH  │  │ KEYWORD SEARCH │  │  GRAPH TRAVERSE │
    │                 │  │                │  │                 │
    │ ANN over stored │  │ SQLite FTS5    │  │ Follow deps     │
    │ embeddings      │  │ + BM25 scoring │  │ hot→warm→cold   │
    └────────┬────────┘  └───────┬────────┘  └──────┬──────────┘
             │                   │                   │
             └───────────────────┼───────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │     RESULT FUSION        │
                    │                          │
                    │  Merge + deduplicate     │
                    │  Score combining         │
                    │  Reciprocal Rank Fusion  │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │      RE-RANKER            │
                    │                           │
                    │  Keyword overlap (now)    │
                    │  Cross-encoder (future)   │
                    │  LLM judge (future)       │
                    └────────────┬──────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │    BUDGET CONTROLLER      │
                    │                           │
                    │  Fill to N tokens         │
                    │  Respect tier priority    │
                    │  Collapse siblings        │
                    └────────────┬──────────────┘
                                 │
                          RETRIEVED CONTEXT
                          (fits in window)
```

## Component Breakdown

### 1. Persistent Vector Store (the foundation)

**Problem:** Embeddings are currently computed fresh every time `scoreChunks` is called.
For 1000 chunks, that's 1000 embeddings per query. With the local ONNX model that takes
~50ms each = 50 seconds. Unusable for retrieval.

**Solution:** Store embeddings in SQLite alongside chunks.

```
New table: chunk_embeddings
  - chunkId TEXT PRIMARY KEY
  - embedding BLOB  (Float32Array serialized)
  - model TEXT      (which model produced it)
  - timestamp INTEGER

New index: virtual table using vec0 (sqlite-vec extension)
  for approximate nearest neighbor search
```

**Implementation:**
- On `storeChunk()`, also compute and store the embedding
- `searchByVector(query, topK)` — embed query, do cosine similarity against stored embeddings
- For ANN at scale (>10K chunks): use `sqlite-vec` or `hnswlib-node`
- For small scale (<10K chunks): brute-force cosine similarity in-memory is fast enough

**Alternative without native extensions:** Store embeddings as BLOB, load all into memory,
do brute-force search. With 10K chunks at 384 dims, that's ~15MB in RAM — trivial.

### 2. Full-Text Search

**Problem:** `textContains` filter uses `LIKE '%keyword%'` — no ranking, no stemming,
no multi-word queries.

**Solution:** SQLite FTS5 virtual table.

```sql
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  path,
  source,
  content='chunks',
  content_rowid='rowid'
);

-- Trigger to keep in sync
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, path, source)
  VALUES (new.rowid, new.text, new.path, new.source);
END;
```

Benefits:
- BM25 ranking out of the box
- Multi-word queries: `"authentication middleware"`
- Phrase matching: `"NEAR(jwt, token, 3)"`
- Column-specific search: `path:src/auth`

### 3. Query Planner

**Problem:** A single user query often needs multiple retrieval strategies.
"How does auth work and why is login failing?" has two intents.

**Solution:** A lightweight query planner that:

1. **Intent detection** — Classify query as:
   - `code_search` — "where is the auth middleware?"
   - `debug` — "why is login failing?"
   - `explain` — "how does the scoring work?"
   - `implement` — "add rate limiting to the API"

2. **Query expansion** — For each intent, generate sub-queries:
   - Original: "fix auth bug"
   - Expanded: ["authentication", "login", "jwt", "middleware", "error"]

3. **Token budget** — Set max tokens based on intent:
   - `debug` → 60% budget (need lots of context)
   - `implement` → 40% budget (need constraints + relevant code)
   - `explain` → 30% budget (need one focused area)

4. **Strategy selection** — Pick which retrievers to run:
   - Code search → vector + FTS + graph
   - Debug → FTS (error strings) + recency-boosted vector
   - Explain → vector + dependency traversal

Implementation is deterministic (rule-based) by default, LLM-powered when
`LLM_COMPRESSION_ENDPOINT` is configured.

### 4. Hybrid Search + Fusion

**Problem:** Vector search catches semantic similarity but misses exact keyword matches.
FTS catches keywords but misses semantics. Neither follows code dependencies.

**Solution:** Run all three in parallel, fuse results.

```typescript
interface RetrievalResult {
  chunkId: string;
  score: number;
  source: 'vector' | 'fts' | 'graph';
  reason: string;
}

function reciprocalRankFusion(
  resultSets: RetrievalResult[][],
  k: number = 60
): RetrievalResult[] {
  // RRF score = 1 / (k + rank) for each result list
  // Combine scores from all lists, sort by combined score
}
```

This is a standard technique from RAG research. Each retriever produces ranked results,
RRF merges them. A chunk that appears in vector results AND FTS results AND graph results
naturally ranks highest.

### 5. Budget Controller

**Problem:** The current router doesn't have a token budget concept built into retrieval.
It routes chunks into tiers, but doesn't say "here are exactly N tokens of the best context."

**Solution:** A budget controller that takes ranked results and fills to a token budget.

```typescript
function fillBudget(
  ranked: RetrievalResult[],
  chunks: Map<string, ContextChunk>,
  maxTokens: number,
  options?: { preferHot?: boolean; collapseSiblings?: boolean }
): {
  selected: ContextChunk[];
  totalTokens: number;
  omitted: { chunkId: string; reason: string }[];
}
```

Behavior:
1. Start with hot-tier chunks (always included if they fit)
2. Add warm chunks by score until budget is full
3. If `collapseSiblings`, merge chunks with the same `parentId` into one entry
4. Track what was omitted and why (for `explain_routing`)

### 6. Multi-Hop Retrieval

**Problem:** "How does auth work?" matches the auth middleware. But auth middleware calls
the JWT validator, which calls the key store. A single retrieval pass misses the chain.

**Solution:** Follow the dependency graph iteratively.

```typescript
async function multiHopRetrieve(
  seedChunkIds: string[],
  maxHops: number,
  maxChunks: number
): Promise<string[]> {
  const visited = new Set<string>(seedChunkIds);
  let frontier = seedChunkIds;

  for (let hop = 0; hop < maxHops; hop++) {
    const nextFrontier: string[] = [];
    for (const id of frontier) {
      const deps = getDependencies(id);
      for (const dep of deps) {
        const other = dep.fromId === id ? dep.toId : dep.fromId;
        if (!visited.has(other) && visited.size + nextFrontier.length < maxChunks) {
          nextFrontier.push(other);
          visited.add(other);
        }
      }
    }
    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return [...visited];
}
```

### 7. Retrieval-Augmented Scoring (Upgrade to Current Scorer)

**Problem:** The scorer currently scores ALL chunks against a task. With 10K+ chunks,
that means 10K+ embedding computations per query.

**Solution:** Two-phase approach:

1. **Retrieve** (cheap, fast) — Use vector + FTS + graph to get top-100 candidates
2. **Score** (expensive, accurate) — Run full multi-factor scoring on only the top-100

This is the standard RAG pattern: retrieve-then-rerank. The current scorer becomes the
reranker. The new retrieval layer is the first-pass filter.

## Implementation Phases

### Phase 1: Vector Persistence + Brute-Force Search
**Files:** `src/storage/schema.ts`, `src/storage/repository.ts`, `src/core/ingester.ts`
- Add `chunk_embeddings` table to schema
- On `storeChunk()`, compute embedding and store it
- Add `searchByVector(queryEmbedding, topK)` — brute-force cosine similarity
- Migration: backfill embeddings for existing chunks
- ~3-4 hours

### Phase 2: Full-Text Search with FTS5
**Files:** `src/storage/schema.ts`, `src/storage/repository.ts`
- Add FTS5 virtual table + sync triggers
- Add `searchByText(query, topK)` with BM25 ranking
- ~2 hours

### Phase 3: Hybrid Retrieval + Fusion
**Files:** NEW `src/core/retriever.ts`, `src/pipeline/orchestrator.ts`
- `HybridRetriever` class that runs vector + FTS + graph in parallel
- Reciprocal Rank Fusion to merge results
- Wire into `getRelevantMemory` MCP tool
- ~3-4 hours

### Phase 4: Budget Controller
**Files:** NEW `src/core/budget.ts`, `src/mcp/server.ts`
- Token-budget-aware result selection
- Hot preference, sibling collapsing
- New MCP tool or enhance `score_context` with budget
- ~2 hours

### Phase 5: Query Planning
**Files:** NEW `src/core/query-planner.ts`
- Intent detection (rule-based)
- Query expansion (keyword extraction + synonym generation)
- Strategy selection per intent
- ~3 hours

### Phase 6: Multi-Hop Retrieval
**Files:** `src/core/retriever.ts`
- Dependency graph traversal from seed chunks
- Hop-limited, count-limited expansion
- Wire into hybrid retriever
- ~2 hours

### Phase 7: ANN Search (Scale Optimization)
**Files:** `src/storage/vector-index.ts`
- For >10K chunks: integrate sqlite-vec or hnswlib-node
- Same interface as brute-force, just faster
- Optional dependency — falls back to brute-force if not available
- ~4 hours

### Phase 8: Context Chunker Integration
**Files:** See `PLAN-context-chunking.md`
- Pre-ingestion splitting for oversized input
- This plugs into Phase 1 naturally — each sub-chunk gets its own embedding
- ~6-8 hours (per the existing plan)

## How It All Fits Together

```
Current Spacefolding:
  ingest → classify → store → [manual score] → route → compress

With RAG:
  ingest → classify → embed → store (chunk + embedding + FTS index)
                                        │
  query → plan → retrieve (vector + FTS + graph) → fuse → rerank → budget → result
                                                                              │
                                                                     feed to LLM / agent
```

The key insight: **Spacefolding's existing scoring/routing IS the reranker.** What's missing
is the retrieval layer that comes before it.

## New MCP Tools (or Enhanced Existing)

| Tool | Change |
|------|--------|
| `retrieve_context` | **NEW** — Query-aware retrieval with token budget |
| `get_relevant_memory` | **ENHANCED** — Uses hybrid search instead of simple scoring |
| `score_context` | **ENHANCED** — Two-phase: retrieve then score |
| `explain_routing` | **ENHANCED** — Shows retrieval path, fusion scores |

### `retrieve_context` (new)

```json
{
  "query": "How does JWT authentication work?",
  "maxTokens": 50000,
  "strategy": "hybrid",
  "maxHops": 2,
  "filters": { "path": "src/auth" }
}
```

Returns:
```json
{
  "chunks": [
    {
      "id": "abc123",
      "text": "...",
      "score": 0.92,
      "tier": "hot",
      "retrievalSources": ["vector", "fts", "graph"],
      "reasons": ["semantic match: 0.88", "keyword match: jwt auth", "dependency of hot chunk def456"]
    }
  ],
  "totalTokens": 48500,
  "budgetUsed": "97%",
  "omitted": [
    { "chunkId": "xyz789", "reason": "exceeds token budget (score: 0.31)" }
  ]
}
```

## Priority Recommendation

**Start with Phase 1 (vector persistence) + Phase 8 (context chunker).**

These two together solve the most pressing problems:
1. Context that's too large gets split automatically
2. Embeddings are stored and searchable, not recomputed every time

Then Phase 2 (FTS) + Phase 3 (hybrid retrieval) give you real RAG search.
Then Phase 4-6 are quality improvements.
Phase 7 is for scale.

Total estimated effort: 25-30 hours across all phases.
