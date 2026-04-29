# Remaining Recommendations — Plans

## ✅ Completed

### #3: Adaptive Budget Sizing
**Status:** DONE (commit `efe62a7`)
- Added `estimateComplexity()` to `query-planner.ts` that classifies queries as narrow/moderate/broad
- Broadening signals: "all", "entire", "architecture", etc. → increased budget
- Narrowing signals: specific paths, "exact", "only" → reduced budget
- `adaptiveBudgetRatio()` adjusts base ratio ±30% based on complexity
- 3 new tests: moderate (default), narrow, and broad query handling

### #6: Statistical Significance
**Status:** DONE (commit pending)
- Added `bootstrapCI()` to `ablation.ts` — 10,000 bootstrap resamples, 95% CI
- Reports mean ± CI for R@10, NDCG@10, MRR per strategy
- Pairwise significance test: vector-only vs all others
- Reports Δ difference with CI, flags if significant (CI excludes 0)

---

## 📋 Planned: #1 — Scale Benchmark 20→200 Tasks

### Goal
Create a benchmark dataset with 200+ tasks across multiple codebases for credible academic evaluation.

### Approach
1. **Keep the existing 20 hand-crafted tasks** as the "expert" evaluation set
2. **Generate synthetic tasks** by:
   - For each file in the codebase, create tasks like "find where [function] is defined", "fix the bug in [module]"
   - Use the file's exports, classes, and functions as ground truth
3. **Add a second codebase** (e.g., a popular open-source TypeScript project like `express` or `zod`) for cross-codebase validation
4. **Add difficulty levels**: easy (1 relevant file), medium (2-3), hard (4+)

### Files to Create/Modify
| File | Change |
|------|--------|
| `benchmarks/dataset-large.json` | New 200+ task dataset |
| `benchmarks/generate-tasks.ts` | Script to auto-generate tasks from source files |
| `benchmarks/ablation.ts` | Support `--dataset` flag for different datasets |

### Effort: ~4 hours
### Priority: High (needed for academic credibility)

---

## 📋 Planned: #2 — LLMLingua Comparison

### Goal
Compare Spacefolding's chunk-level summarization against LLMLingua's token-level compression.

### Approach
1. Install `llmlingua` Python package
2. Create a `LlmLinguaCompressionProvider` that wraps the Python library
3. Run the ablation benchmark with LLMLingua compression for the compress-overflow step
4. Compare: compression ratio, information retention (R@10), and latency

### Implementation

```python
# scripts/llmlingua-compressor.py
from llmlingua import PromptCompressor
import json, sys

compressor = PromptCompressor()

for line in sys.stdin:
    req = json.loads(line)
    compressed = compressor.compress_prompt(
        req['context'],
        rate=req.get('rate', 0.5),
        force_tokens=req.get('force_tokens', []),
    )
    print(json.dumps({
        'compressed': compressed['compressed_prompt'],
        'ratio': compressed['ratio'],
        'origin_tokens': compressed['origin_tokens'],
        'compressed_tokens': compressed['compressed_tokens'],
    }))
```

```typescript
// src/providers/llmlingua-compression.ts
// Similar to GpuEmbeddingProvider — Python subprocess with JSON-RPC
```

### Files to Create/Modify
| File | Change |
|------|--------|
| `scripts/llmlingua-compressor.py` | Python wrapper for LLMLingua |
| `src/providers/llmlingua-compression.ts` | TypeScript provider |
| `benchmarks/ablation.ts` | Add LLMLingua compression strategy |
| `benchmarks/COMPRESSION-COMPARISON.md` | Results document |

### Effort: ~3 hours
### Priority: Medium (nice-to-have comparison)

---

## 📋 Planned: #4 — Iterative Retrieval

### Goal
Add iterative retrieval: retrieve → LLM generates partial code → re-retrieve based on generated code → refine.

### Approach
This is the biggest architectural change. The key insight from RepoCoder (Zhang et al., 2023):

```
Round 1: retrieve_context("implement auth") → chunks A, B, C
         LLM generates: "import { verify } from './jwt.js'; ..."
Round 2: retrieve_context("verify jwt.js auth token") → chunks D, E (new context!)
         LLM generates: more complete code with D, E context
Round 3: (optional) re-retrieve with full context
```

### Implementation Sketch

```typescript
// New method in PipelineOrchestrator
async iterativeRetrieve(
  query: string,
  maxRounds: number = 2,
  maxTokens?: number,
): Promise<{
  rounds: Array<{
    query: string;
    chunks: ContextChunk[];
    generatedContext?: string; // What the LLM "learned" from this round
  }>;
  finalChunks: ContextChunk[];
}> {
  const rounds = [];
  let currentQuery = query;
  const seenChunks = new Set<string>();

  for (let round = 0; round < maxRounds; round++) {
    const result = await this.retrieve(currentQuery, maxTokens);
    const newChunks = result.chunks.filter(c => !seenChunks.has(c.id));

    rounds.push({
      query: currentQuery,
      chunks: newChunks,
    });

    newChunks.forEach(c => seenChunks.add(c.id));

    // For the next round, expand the query with terms from retrieved chunks
    // (This is a heuristic — in a full implementation, the LLM would generate)
    const expandedTerms = newChunks
      .flatMap(c => c.text.split(/\s+/))
      .filter(w => w.length > 5)
      .slice(0, 10);
    currentQuery = `${query} ${expandedTerms.join(' ')}`;
  }

  return { rounds, finalChunks: rounds.flatMap(r => r.chunks) };
}
```

### Design Decisions Needed
1. **Who generates the intermediate context?** The MCP client (Claude Code) or Spacefolding itself?
   - **Recommendation:** Spacefolding returns retrieved chunks each round; the client decides whether to re-retrieve
2. **How to expand the query?** Keyword extraction from retrieved chunks vs LLM-generated follow-up queries
3. **Deduplication across rounds** — only return new chunks each round
4. **MCP interface** — new `iterative_retrieve` tool or extend `retrieve_context` with `rounds` parameter?

### Files to Create/Modify
| File | Change |
|------|--------|
| `src/pipeline/orchestrator.ts` | Add `iterativeRetrieve()` method |
| `src/mcp/server.ts` | Add `iterative_retrieve` tool or `rounds` parameter |
| `src/core/query-planner.ts` | Query expansion from retrieved chunks |
| `tests/rag.test.ts` | Test iterative retrieval |

### Effort: ~6-8 hours
### Priority: Medium (significant improvement for complex tasks, but large change)

---

## 📋 Planned: #5 — Human Evaluation

### Goal
Measure whether compress-overflow actually helps developers complete tasks faster.

### Approach
This requires human participants and cannot be coded. The study design:

1. **Recruit 10-20 developers** with TypeScript experience
2. **Create 10 coding tasks** on the Spacefolding codebase (debug, implement, explain, search)
3. **A/B test**:
   - Group A: Claude Code with Spacefolding (full: vector retrieval + compress-overflow)
   - Group B: Claude Code with raw file reading (no Spacefolding)
   - Group C: Claude Code with Spacefolding but no compression (ablation)
4. **Metrics**:
   - Task completion rate
   - Time to completion
   - Number of files manually read
   - Quality of solution (blind code review)
   - Developer satisfaction (Likert scale)

### Effort: ~2-3 weeks (human recruitment + study)
### Priority: Low (academic credibility, but high effort)
### Note: This is a human study, not a code task

---

## Execution Priority

| Order | Item | Impact | Effort | Type |
|-------|------|--------|--------|------|
| 1 | ✅ Adaptive budget sizing | High | 1h | Code |
| 2 | ✅ Statistical significance | High | 1h | Code |
| 3 | Scale benchmark | High | 4h | Data + code |
| 4 | LLMLingua comparison | Medium | 3h | Research + code |
| 5 | Iterative retrieval | High | 8h | Architecture |
| 6 | Human evaluation | High | 3 weeks | Human study |
