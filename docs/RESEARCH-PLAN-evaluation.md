# Research Plan: Is Spacefolding Better Than Stock LLMs and CLIs?

## The Honest Answer

**It depends on what problem you're solving. And right now, the honest answer is "we don't know."**

Here's what we do know:

### What "Stock" Looks Like in 2026

| Tool | Context Strategy | Strengths | Weaknesses |
|------|-----------------|-----------|------------|
| **Claude Code (stock)** | Manual file adds, prompt caching, auto-compaction | Native integration, zero setup, prompt caching is extremely efficient (90% cost reduction) | No persistent memory between sessions, no scoring, you manually pick files |
| **Aider** | Repository map (tree-sitter AST + graph ranking), sends symbol signatures | Extremely efficient token usage, understands code structure natively, graph-based relevance | No semantic search, no compression, no persistent memory, single-session only |
| **Cursor** | Codebase indexing (embeddings + keyword search), inline context injection | Real-time autocomplete with codebase awareness, low latency, polished UX | Proprietary, cloud-dependent, no explicit tier routing, no compression |
| **Continue.dev** | Embeddings + keyword search, slash commands | Open source, extensible, good VS Code integration | No tier-based routing, no dependency graph, no compression pipeline |
| **Copilot** | Neighboring tabs, similar files heuristic, semantic search in backend | Massive scale, fast, works everywhere | Black box, no control over context selection, no persistent memory |
| **Gemini 1M+ tokens** | Just send everything | No context management needed if it fits | When it doesn't fit, you're back to square one. 1M tokens = 1M tokens of cost |

### Where Spacefolding Could Be Better

1. **Persistent memory across sessions** — No other tool does this well. Claude Code forgets everything when you close it. Aider starts fresh. Spacefolding remembers what was important yesterday.

2. **Explicit tier routing** — Most tools are binary: context in or out. Spacefolding has hot/warm/cold with compression. This means you can keep 10x more context accessible without blowing the budget.

3. **Dependency-aware retrieval** — Aider does this with its repo map, but only within a session. Spacefolding builds a persistent dependency graph that survives restarts.

4. **LLM-powered compression** — No other tool compresses warm context with a real LLM. Most just truncate or summarize with heuristics.

5. **MCP integration** — Works with any MCP-compatible agent, not just one IDE or one model.

### Where Spacefolding Is Clearly Worse

1. **Latency** — Every retrieval requires: embed query → vector search → FTS search → fusion → budget fill. Claude Code's native context loading is instant. Cursor's autocomplete is <100ms. Spacefolding's pipeline is multi-second.

2. **Setup complexity** — Stock Claude Code works out of the box. Spacefolding requires Docker, model downloads, MCP configuration, and understanding of the pipeline.

3. **Embedding quality** — The deterministic hash-based embeddings are barely better than random. The local ONNX model (all-MiniLM-L6-v2) is a 2023 model. Claude Code and Cursor use proprietary embeddings trained on code.

4. **No AST awareness** — Aider uses tree-sitter for actual AST parsing. Our code chunker uses regex. This means we split at `function` keywords but miss structural relationships that a real parser would catch.

5. **No evaluation benchmarks** — We have 60 unit tests that check individual components work. We have zero benchmarks measuring whether the system actually helps an LLM produce better code.

6. **No user studies** — We have no evidence that a developer using Spacefolding produces better code, faster, than without it.

7. **Scale limits** — Brute-force vector search over all embeddings per query. At 100K+ chunks this will be unusable. Aider's graph ranking handles repos with 10K+ files.

## The Core Question We Can't Answer Yet

**Does intelligent context selection + compression actually improve LLM output quality compared to just sending more context?**

The assumption behind Spacefolding is:
> Better context selection → better LLM output → better code

But we haven't proven this. It's possible that:
- Sending 200K tokens of raw context (with prompt caching) is just as effective and simpler
- The compression step loses critical information that the LLM would have used
- The routing is wrong often enough that it hurts more than it helps
- The setup cost outweighs the benefit for 95% of use cases

## Research Plan

### Phase 1: Build a Benchmark (Week 1)

**Goal:** Create a reproducible evaluation framework.

#### 1.1 Context Retrieval Accuracy Benchmark

Create a dataset of 50 coding tasks with known-relevant files:

```json
{
  "task": "Fix the authentication bug causing 401 errors",
  "relevant_files": ["src/auth/jwt.ts", "src/middleware/auth.ts"],
  "relevant_constraints": ["Must use JWT tokens"],
  "irrelevant_files": ["src/utils/logger.ts", "docs/api.md"]
}
```

Measure:
- **Recall@K** — Of the truly relevant files, how many appear in the top K results?
- **Precision@K** — Of the top K results, how many are actually relevant?
- **NDCG** — Are the most relevant files ranked highest?

Compare against baselines:
- **Random** — Pick K random chunks
- **Keyword** — Simple grep for task terms
- **Aider-style** — Send repo map, let LLM pick files
- **Brute-force** — Send everything (measure cost)

#### 1.2 Compression Quality Benchmark

Take 10 chunks of warm context. For each:

1. Send the raw text to Claude, ask it to answer a question
2. Send the compressed summary to Claude, ask the same question
3. Compare answers using an LLM judge (or human evaluation)

Measure:
- **Information retention** — Did the compressed version preserve the key facts?
- **Answer quality** — Did the LLM give the same quality answer?
- **Token savings** — How many tokens were saved?

#### 1.3 End-to-End Task Benchmark

Create 20 tasks in a real codebase (e.g., Spacefolding itself):

1. Run Claude Code with Spacefolding (MCP integration)
2. Run Claude Code without Spacefolding (stock)
3. Measure:
   - Task completion rate (does it compile and pass tests?)
   - Code quality (lint score, test coverage)
   - Token usage (total tokens consumed)
   - Time to completion

### Phase 2: Comparative Evaluation (Week 2)

**Goal:** Compare Spacefolding against 3 baselines on the same tasks.

#### Baseline 1: Stock Claude Code
- Claude Code with default context management
- Add relevant files manually
- Use prompt caching

#### Baseline 2: Aider
- Use aider's repo map
- Same tasks
- Measure token usage and completion rate

#### Baseline 3: Brute Force (send everything)
- Send all files in the repo to the LLM
- Maximum context, zero intelligence
- This is the "upper bound" on quality (but maximum cost)

#### Metrics to Track

| Metric | Stock Claude | Aider | Brute Force | Spacefolding |
|--------|-------------|-------|-------------|--------------|
| Task completion % | ? | ? | ? | ? |
| Average tokens per task | ? | ? | ? | ? |
| Cost per task ($) | ? | ? | ? | ? |
| Time per task (s) | ? | ? | ? | ? |
| Retrieval recall@10 | N/A | ? | 100% | ? |
| Retrieval precision@10 | N/A | ? | low | ? |

### Phase 3: Ablation Study (Week 3)

**Goal:** Figure out which parts of Spacefolding actually matter.

Test each configuration:
1. **No routing** — Send all chunks (brute force)
2. **Routing only** — Hot/warm/cold but no compression
3. **Routing + deterministic compression** — Full pipeline, no LLM
4. **Routing + LLM compression** — Full pipeline with LLM compression
5. **Routing + LLM compression + graph traversal** — Everything

For each, measure task completion rate and token usage. This tells us whether compression helps or hurts, whether graph traversal matters, and where the value actually comes from.

### Phase 4: Real-World Usage Study (Week 4)

**Goal:** Measure real developer experience.

1. Have 3-5 developers use Spacefolding for a week on their real projects
2. Track:
   - How often they use retrieve vs manual file selection
   - Whether retrieval finds what they need
   - Token savings vs their normal workflow
   - Subjective satisfaction (survey)
3. Interview them about what works and what doesn't

### Phase 5: Competitive Differentiation Paper (Week 5)

**Goal:** Write up findings as a blog post or paper.

Sections:
1. **Problem definition** — Context overflow in coding agents
2. **Our approach** — Tier-based routing + compression + RAG
3. **Evaluation methodology** — Benchmarks, baselines, metrics
4. **Results** — Honest numbers, including where we lose
5. **Analysis** — When is this approach worth it? When isn't it?
6. **Lessons learned** — What surprised us

## Immediate Next Steps (This Week)

### Step 1: Create the benchmark dataset

Write a script that:
1. Takes a real codebase (Spacefolding itself)
2. Generates 20-30 task descriptions
3. For each task, identifies the truly relevant files/constraints
4. Packages this as `benchmarks/dataset.json`

### Step 2: Wire up retrieval evaluation

Write `benchmarks/evaluate-retrieval.ts`:
```
For each task in dataset:
  1. Query Spacefolding retrieve_context
  2. Compare results against ground truth
  3. Compute recall@K, precision@K, NDCG
```

### Step 3: Build a simple baseline

Write `benchmarks/baseline-keyword.ts`:
```
For each task:
  1. Grep for task keywords across all chunks
  2. Return top K matches
  3. Compare against same ground truth
```

### Step 4: Run and publish results

Run both on the same dataset. Publish the numbers honestly — even if Spacefolding loses to keyword search on some tasks.

## The Hard Truths

1. **We're competing with prompt caching.** Claude's prompt caching gives 90% cost reduction on repeated context. If the LLM already has the codebase cached, our compression provides zero marginal benefit.

2. **Context windows are growing.** Gemini has 1M+ tokens. Claude has 200K. If context windows keep growing, the "context overflow" problem Spacefolding solves shrinks.

3. **Latency is a killer.** Stock Claude Code loads context instantly. Our retrieval pipeline adds 1-5 seconds per query. For interactive coding, that's a significant penalty.

4. **Setup cost is real.** Docker, model downloads, MCP configuration — most developers won't bother for a marginal improvement.

5. **The value proposition narrows to specific scenarios:**
   - Codebases too large for any context window (>1M tokens)
   - Multi-session work where persistent memory matters
   - Teams sharing a context store
   - Environments where you want deterministic, reproducible context selection

6. **We should consider pivoting the value proposition** from "better than stock" to "enables things stock can't do" — persistent memory, cross-session context, team-shared context stores, reproducible retrieval.

## What I'd Actually Recommend

Before building more features, **prove the core hypothesis**:

> A coding agent with Spacefolding produces measurably better results than without it, on real tasks, at lower token cost.

If the benchmark shows this is true → double down, market the numbers.
If it shows mixed results → figure out exactly where the value is and focus there.
If it shows it's not true → the architecture is wrong and needs rethinking.

The research plan above is the path to finding out.
