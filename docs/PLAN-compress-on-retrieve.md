# Plan: Automatic Compression in Retrieve Path

## Problem

`retrieve_context` returns **full verbatim text** of every chunk that fits the token budget. Large chunks eat the budget, and chunks that *almost* fit are just omitted entirely. The compression provider (deterministic, local, or LLM) is only used when you explicitly call `compress_context` — it never runs during retrieval.

**The gap:** A coding agent calls `retrieve_context("fix auth bug", 50000)` and gets back 3 large files at 15K tokens each = 45K tokens of raw source code. The 4th file (also relevant) doesn't fit. If we could *compress* the 3 files into summaries, we'd have room for the 4th file plus a summary of it.

## Solution

Add a **compress-overflow mode** to the retrieve path. When chunks don't fit the budget, compress them into summaries and try again.

### Design

```
retrieve_context(query, maxTokens=50000)
  │
  ├─ 1. Retrieve top-100 chunks via hybrid search
  ├─ 2. Fill budget with best chunks (current behavior)
  │     → selected: [chunk_A (8K), chunk_B (12K), chunk_C (15K)] = 35K tokens
  │     → omitted: [chunk_D (20K — doesn't fit)]
  │
  ├─ 3. NEW: If utilization < 80% OR omitted > 0:
  │     → Check if omitted chunks could fit if compressed
  │     → For each omitted chunk, estimate compressed size (~10-15% of original)
  │     → Compress the largest omitted chunks via compression provider
  │     → Add compressed summaries to result as tier="compressed"
  │
  └─ 4. Return selected verbatim + compressed summaries
        → chunks: [
            {text: "...full...", tier: "hot", tokensEstimate: 8000},
            {text: "...full...", tier: "warm", tokensEstimate: 12000},
            {text: "...full...", tier: "warm", tokensEstimate: 15000},
            {text: "Summary: Task fix auth bug. Code refs: src/auth/login.ts...", tier: "compressed", tokensEstimate: 200},
          ]
```

## Changes Required

### 1. Add compression to budget fill (`src/core/budget.ts`)

The budget filler currently just omits chunks that don't fit. Add an optional callback that compresses omitted chunks:

```typescript
interface BudgetOptions {
  hotChunkIds?: Set<string>;
  collapseSiblings?: boolean;
  compressOmitted?: boolean;           // NEW
  compressionEstimate?: (tokens: number) => number;  // NEW: estimate compressed size
}

// After Phase 2, if compressOmitted is true:
// Phase 3: Try to fit compressed versions of omitted chunks
```

### 2. Wire compression into retrieve (`src/pipeline/orchestrator.ts`)

The `retrieve()` method needs access to the compression provider (it already has `this.compressionProvider`). After budget fill, compress the best omitted chunks:

```typescript
const budgetResult = fillBudget(retrieval, chunkMap, budget, { ... });

// NEW: Compress omitted chunks that are highly relevant
if (budgetResult.omitted.length > 0) {
  const compressible = budgetResult.omitted
    .filter(o => o.reason === 'exceeds remaining budget')
    .sort((a, b) => retrieval.find(r => r.chunkId === a.chunkId)?.score ?? 0)
    .slice(0, 5);  // Max 5 compressed summaries

  for (const omitted of compressible) {
    const chunk = chunkMap.get(omitted.chunkId);
    if (!chunk) continue;
    const compressed = await this.compressionProvider.compress(
      { text: query },
      [chunk]
    );
    // Create a synthetic "compressed" chunk
    const compressedChunk: ContextChunk = {
      ...chunk,
      text: compressed.summary,
      tokensEstimate: estimateTokens(compressed.summary),
      metadata: { ...chunk.metadata, compressedFrom: chunk.id },
    };
    budgetResult.selected.push(compressedChunk);
    budgetResult.tiers.set(compressedChunk.id, 'cold');
    budgetResult.totalTokens += compressedChunk.tokensEstimate;
  }
}
```

### 3. Update MCP return schema (`src/mcp/server.ts`)

Add a `compressed` tier to the return format so the LLM knows what's verbatim vs summarized:

```typescript
chunks: result.chunks.map((c) => ({
  ...
  tier: result.tiers.get(c.id) ?? 'warm',  // 'hot', 'warm', or 'compressed'
  compressedFrom: c.metadata?.compressedFrom,  // NEW: original chunk ID if compressed
})),
```

### 4. Update the BudgetResult type

Add a `compressed` array to `BudgetResult`:

```typescript
interface BudgetResult {
  selected: ContextChunk[];
  compressed: { chunkId: string; summary: string; tokensEstimate: number }[];  // NEW
  tiers: Map<string, ContextTier>;
  totalTokens: number;
  budget: number;
  utilization: number;
  omitted: { chunkId: string; tokensEstimate: number; reason: string }[];
}
```

## Files to Change

| File | Change |
|------|--------|
| `src/core/budget.ts` | Add Phase 3 (compress omitted), update `BudgetResult` type |
| `src/pipeline/orchestrator.ts` | Wire compression into `retrieve()`, pass provider |
| `src/mcp/server.ts` | Add `compressed` info to `retrieve_context` response |
| `src/types/index.ts` | Add `'compressed'` to `ContextTier` type |
| `tests/rag.test.ts` | Add test for compress-overflow behavior |

## What Does NOT Change

- `ingest` — unchanged, still stores full text
- `score_context` — unchanged, still scores and routes
- `compress_context` — unchanged, still available as explicit tool
- Storage layer — unchanged, compression happens at retrieval time only
- Compression providers — unchanged, we just call them from a new place

## Risk Mitigation

1. **Compression is slow** (especially LLM). Solution: Only compress up to 5 omitted chunks, and only when there's budget space for the summary.
2. **Compression loses information.** Solution: Always include the original chunk ID (`compressedFrom`) so the LLM can request the full text if needed.
3. **Compression might not help.** If the budget is already tight, compressed summaries still won't fit. Solution: Check compressed size estimate before actually calling the provider.

## Validation

After implementation:
1. Unit test: budget fill with compression callback
2. Integration test: retrieve with maxTokens that forces compression
3. MCP test: verify `retrieve_context` returns compressed chunks with correct tier
4. Benchmark: re-run ablation to check if compression improves R@10 (it shouldn't hurt recall since we're ADDING info, not replacing)

## Effort

~2-3 hours of implementation + testing. The changes are localized to 5 files.
