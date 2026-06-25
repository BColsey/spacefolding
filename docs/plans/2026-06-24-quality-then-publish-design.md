# Design — "Quality then publish" next steps

- **Date:** 2026-06-24
- **Status:** Approved (owner, 2026-06-24) → handing off to writing-plans for implementation plan
- **Origin:** brainstorming session; findings from a 7-agent ultracode research sweep (retrieval SOTA, competitor context management, compression+prompt-caching, MCP ecosystem, scale/vector-store infra, positioning/launch). All load-bearing code claims below are **verified against current `main`**.
- **Supersedes nothing** — this sequences work that overlaps the existing roadmap (`NEXT-PHASES.md` P5/P6/P7/D5); it reframes P5 and inserts pre-publish efficiency/surface phases.

## Where the project stands

Core credibility work (Phases 1–8), the launch artifact (grep head-to-head: hybrid beats agentic-grep on tokens-to-first-correct-file at ≥10k files), and D1–D4 invisible delivery (12→4 advertised tools, plugin scaffold, hooks, `init`) are on `main` (~503 tests green, frozen blocking gate green). **D5 (`npm publish`) is pending explicit owner go.** Remaining roadmap: P5 ranking cleanup (typed boost fields; review-gated on `ws03-ranking-cleanup`), P6 chunk sweep, P7 model verification + planner retune.

## What the research found (verified)

| Claim | Verdict |
|---|---|
| Reranker is jaccard word-overlap | ✅ `src/providers/deterministic-reranker.ts` — `matchCount/queryWords.size`; reasons are direct/partial/no keyword overlap. No model. |
| `vector-index.ts add()` = per-row INSERT + `COUNT(*)` | ✅ line 175 INSERT + line 178 `loadCount()` → `SELECT COUNT(*)` on the vec0 table, on every add. The literal cause of the "60k ingestion-bound" drop. |
| `formatContextPack` emits a volatile header | ✅ `Query:` (l.36), `Tokens/utilization` (l.44), dynamic `Scores` (l.77) all lead the pack → defeats prompt caching on every MCP call. |
| Server advertises only `{tools:{}}`, JSON-as-text | ✅ `server.ts:543` `{capabilities:{tools:{}}}`; all results via `jsonResponse()` (l.899). No resources / structuredContent. |

**The convergent headline:** the reranker is the #1 quality lever — flagged independently by the retrieval-SOTA, competitor, and Anthropic-contextual-retrieval threads. It discards the expensive RRF signal at the final re-order step and targets the project's exact differentiation metric (tokens-to-first-correct-file). It is a drop-in behind the existing `RerankerProvider` on the transformers.js/onnxruntime stack already installed.

**Recurring honesty risk (load-bearing):** none of the researched changes make Spacefolding a *universal winner*. The durable, proven edge is **exact-identifier top-1 localization**, which collapses under the symbol-removed ablation. Every quality change must be gated on re-running the blocking ablation, and positioning must keep the "no universal winner; durable edge = top-1 localization" framing.

## Decision: "Quality then publish"

Sequenced 4-phase plan: bank verified zero-risk wins → land the reranker behind the honesty gate → modernize the MCP surface → publish with sharpened positioning. Deferred items stay on the roadmap.

---

## Phase Q1 — Verified quick wins (no model deps, low risk) · ~1d

### Q1a. Cache-aware Context Pack — `src/core/context-pack.ts`
- **Problem:** `formatContextPack` leads with volatile per-query lines (`Query:`, `Tokens/utilization`, `Scores`), so the pack defeats prompt caching on every MCP call.
- **Change:** freeze a **stable prefix** (instructions / static reference) and move volatile data (query string, scores, utilization, candidate counts) to a trailing section.
- **Test:** the stable prefix is byte-identical across same-chunks/different-query inputs; existing pack tests stay green.
- **Gate:** none (pure serialization reorder).

### Q1b. Batched vec0 inserts + kill per-call `COUNT(*)` — `src/storage/vector-index.ts`
- **Problem:** `add()` runs `INSERT` + `loadCount()` (`SELECT COUNT(*)` on the vec0 table) **per chunk** — the literal cause of the "60k ingestion-bound" drop. (`loadFromDb` already batches in a transaction.)
- **Change:** add an `addMany(chunks, embeddings)` transactional bulk path that maintains count in metadata (no `COUNT(*)` scan); route the watcher/incremental ingestion path through it.
- **Test:** N-chunk `addMany` = 1 transaction, 0 `COUNT(*)` scans; re-confirm 60k ingestion is materially faster.
- **Gate:** blocking scale/acceptance tests stay green.

---

## Phase Q2 — Neural cross-encoder reranker (P5 reframed) · ~2–3d · the #1 quality lever

- **Problem:** the jaccard `DeterministicRerankerProvider` throws away the RRF signal at the final re-order step.
- **Change:** add a local `CrossEncoderRerankerProvider` (e.g. `bge-reranker-v2-m3` / `jina-reranker-v2-base`) behind the existing `RerankerProvider` interface, on the transformers.js/onnxruntime stack already installed — **local-first, no cloud.** Select via config; keep the deterministic provider as the offline/CI fallback. Gate reranking to top-K within the token budget so it stays cheap.
- **Fold-in (merge/complete existing `ws03-ranking-cleanup`, don't redo):** typed `symbolExact`/`pathExact` boost fields, and a cheap pure-TS **PageRank repo-map** boost over the already-built symbol-reference graph (Aider-style, no deps). Both compose in the same ranking stage.
- **Honesty gate (load-bearing):** re-run the blocking ablation harness (deterministic non-regression **+** the symbol-removed ablation) before/after. Assert the exact-identifier top-1 edge is **preserved or improved** — never published as a universal winner.
- **Risk:** model download adds first-run weight; deterministic fallback must stay intact for offline/CI.

---

## Phase Q3 — MCP surface modernization (pre-D5; fixes the published shape) · ~1.5–2d

- **Problem:** server advertises only `{tools:{}}` and returns JSON-as-text (scores/IDs burned into model context).
- **Change:** return **`structuredContent`** (machine-readable, out of model context) + **`resource_link`** items (`sf://chunk/{id}`) for lazy resolution; advertise the capability. Adopt Anthropic tool-design rules: resolve opaque chunk IDs → `file:symbol` names by default; add a concise/detailed `response_format`; hard token cap + "narrow your query" steering.
- **Caveat:** verify Claude Code host support before investing in `resources`/`prompts`/`elicitation` (still maturing) — `structuredContent` is safe.
- **Gate:** MCP + frozen blocking tests green; legacy output shapes preserved.

---

## Phase Q4 — D5: npm publish + sharpened positioning · ~1–2d · owner-gated

- **Mechanics:** npm auth + `npm publish` (files allowlist already clean from D1–D4); clean-install smoke (download default model + one-task retrieval sanity reproducing a published result within the non-determinism band).
- **Positioning (messaging/docs/README):**
  - Frame as **"the local-first context-engineering engine for coding agents"** — not "RAG."
  - Lead the claim with **top-1 localization** (deterministic-grade exact-identifier localization, no compiler index), *not* "we beat grep." Publish the symbol-ablation prominently (moat + honesty signal).
  - Name the why: **context rot** (Chroma Research) behind wins-at-scale.
  - State the unoccupied triple: **local-first × invisible-plugin × structural+vector hybrid.**
  - Position FSL-1.1→Apache accurately ("source-available, converts to Apache 2.0 in 2y") — *not* "open source." Model the launch on sqlite-vec v0.1.0.
- **Gate:** 0 critical/high audit; clean install reproduces a published result; honest caveat present.

---

## Deferred (stays on the roadmap, post-publish, ablation-gated)

- Quantized two-stage retrieval (binary candidate scan + float32 rescore) + USearch/HNSW escape hatch past ~100k vectors — defends/extends the scale thesis. **Strictly ablation-gated:** quantization can erode the durable edge more than aggregate NDCG@10 suggests.
- Learned-sparse leg (BGE-M3) fused into RRF — defends the exact-identifier edge.
- Contextual embeddings (LLM chunk prefaces) — P6.
- Default-embedder swap to CodeRankEmbed (137M) / Qwen3-Embedding-0.6B — P7 (model verification + planner retune; CodeRankEmbed requires a query task-instruction prefix).
- Restorable/source-pointer compression + observation-masking warm/cold policy — protects the durable edge from warm-tier compression.
- Contamination-limited eval (CoREB / Voyage-style) — bulletproofs the benchmark against CodeSearchNet-leakage criticism.

## Cross-cutting discipline

Never set a default, re-tune a ranking path, or refactor retrieval without re-running the trusted ablation; never publish a recall or "universal winner" claim the data does not support. The durable edge is exact-identifier top-1 localization — protect it.

## Research basis (selected sources)

- Anthropic, *Contextual Retrieval* (49% / 67% failure reductions) — https://www.anthropic.com/news/contextual-retrieval
- Anthropic, *Writing tools for agents* / *Effective context engineering* — https://www.anthropic.com/engineering/writing-tools-for-agents
- Sourcegraph Cody recommender paper — https://arxiv.org/html/2408.05344v1
- Aider repo-map (PageRank on the reference graph) — https://aider.chat/2023/10/22/repomap.html
- Manus, *Context Engineering for AI Agents* (KV-cache hit rate as the dominant lever) — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Chroma Research, *Context Rot* — recall degrades non-linearly with input tokens.
- sqlite-vec (quantize_binary, scale limits) — https://alexgarcia.xyz/sqlite-vec/guides/binary-quant.html ; https://github.com/asg017/sqlite-vec/issues/25
- MCP 2025-06-18 (structuredContent / resource_link) — https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- CoIR / CodeRankEmbed / Qwen3-Embedding — https://huggingface.co/nomic-ai/CodeRankEmbed ; https://github.com/QwenLM/Qwen3-Embedding
- FSL-1.1 → Apache — https://fsl.software/
