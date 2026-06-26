# Spacefolding — Research Handoff

> **Date:** 2026-06-26 · **Author of this arc:** Claude (with owner) · **Purpose:** a self-contained
> handoff so a new session/person can pick up the research without re-deriving it.
> **Read this first,** then follow the index to the detailed artifacts.

## TL;DR — where things stand

- **Spacefolding** is a competent local-first hybrid-RAG context engine for coding agents. The core build
  is **done** (Phases 1–9 + D1–D4 invisible delivery; ~519 tests green; frozen blocking gate green;
  `npm audit` 0). It is **NOT published**.
- **Strategic verdict (2026-06-25):** the *engine* is **commodified / not defensible as a product** — no
  universal retrieval winner (own data), and the market cell is crowded with funded competitors
  (Zilliz `claude-context` ~12k stars, self-hostable; SocratiCode; `mcp-local-rag`). `v0.1.0` publish
  is **held**.
- **Searched for a novel, defensible research advantage (3 rounds).** All three collapsed under rigorous
  validation: the 4 retrieval directions were **scooped**; **harm-potential** didn't survive realism
  validation (synthetic artifact); **graph-legitimacy** was null as a quality feature.
- **Reframe settled (2026-06-26): rigorous META-EVALUATION** — the contribution is stress-testing
  widely-believed agent-context/RAG claims with the contamination-free harness + realism gates, not a
  novel mechanism. **Paper #1 is already done** ("realistic context harm does not flip code
  localization"). See [`docs/plans/2026-06-26-meta-evaluation-program.md`](plans/2026-06-26-meta-evaluation-program.md).
- **The rare, proven asset is the honesty/evaluation methodology** (contamination-free benchmarks,
  realism gates, pre-registered kill criteria, paired CIs) — not a novel algorithm.

## The arc — what was tried and what was found

### 1. The engine + the strategic verdict
A 4-way adversarial review (bull / bear / market-realism / technical-thesis) + a publish audit concluded
the hybrid-RAG engine has no defensible product edge. Load-bearing facts (from `benchmarks/FROZEN-CLAIM.md`):
no universal retrieval winner; the lone durable edge is **exact-identifier top-1 localization** that holds
only on django+typescript (not rust) and **collapses under the symbol-removed ablation** (django 0.875→0.524,
typescript 0.604→0.320); the edge exists only on the GPU SFR-400M model while the default path's vector arm
is ~random.

### 2. Novel-direction search
- **4 retrieval directions** (verifier-closed-loop, program-analysis-grounded, context benchmark, learned
  eviction) — all **partially scooped** by 2025–2026 prior art (TENET, SliceMate, ContextBench, AdaCoM/KVP/ACON).
- A **wider ideation round** (5 frontier regions → rigorous novelty gate) surfaced one genuinely-novel
  survivor: **per-item causal harm-potential of retrieved context** (no prior work defines per-item causal
  harm, tests its orthogonality to relevance, or frames retrieval as a help-vs-harm Pareto problem).

### 3. Harm-potential — chosen, gated GREEN, then killed by realism
- **E0 gate (GREEN):** a realistic code confuser flips 42.5% (structural) / 31.3% (hybrid) of otherwise-correct
  localizations (CI excl 0; control 0).
- **E1:** harm is **arm-specific** (structural via the symbol arm; hybrid via the FTS arm).
- **E2 (orthogonality):** deferred — internal retrieval scores are circular with the flip.
- **E3 (naive multi-arm corroboration policy):** NEGATIVE (no-op on single-arm structural; worse on hybrid).
- **Realism (R):** REAL cross-project code confusers → **HP = 0.000** everywhere; positive control (synthetic)
  = 0.406 → the harness is sound, the null is genuine. The 42.5%/31.3% were a **synthetic artifact**.
- **Multi-language (M):** on a real ~108k-LOC corpus, structural harm **does not generalize** (small-corpus
  artifact); only FTS→hybrid replicates (modest, underpowered).
- **Learned predictor + legitimacy (L + `legitimacy-eval.ts`):** a graph-legitimacy predictor cuts
  *synthetic*-confuser flips, but does **not** improve real retrieval quality (demotes correct answers:
  structural −0.044, sig).
- **Outcome:** the design's pre-registered kill criterion ("kill if real-failure-mined harm is undetectable")
  was **triggered**. Full record: [`benchmarks/HARM-FINDINGS.md`](../benchmarks/HARM-FINDINGS.md).

### 4. The reframe — rigorous meta-evaluation
Three rounds of plausible-but-wrong "advantages" revealed the real strength: **not fooling yourself.** The
new program makes that the contribution. See the companion program doc.

## Branches & repo state

| Branch | Contents | Status |
|---|---|---|
| `main` | Merged engine: Phases 1–9 (credibility, grep head-to-head) + D1–D4 (invisible delivery: 12→4 tools, plugin, hooks, `init`) | healthy; ~519 tests; **not published** |
| `docs/quality-then-publish-design` | The approved Q1–Q4 design + implementation plan | docs only |
| `quality-then-publish` | Q1–Q4 implemented + merged (cache-aware pack, batched vec0 inserts, default-off cross-encoder reranker, `structuredContent`/`resource_link`, positioning docs) | **green gates; publish-ready if you choose to ship the engine as a tool** |
| `research/harm-potential` | Harm-potential design + 8 experiment scripts + `HARM-FINDINGS.md` + this handoff + the meta-evaluation program doc | the active research line |

## The asset stack (reusable for any future experiment)

- **Contamination-free commit-derived benchmark** (django/typescript/rust) + **symbol-removed ablation**
  harness + **paired-bootstrap CIs** + a public **grep head-to-head** (tokens-to-first-correct-file).
- **The realism-gate pattern** (now formalized): positive control (synthetic/known effect must reproduce)
  + real-data validation (does the effect survive realistic inputs?). Apply to every claim.
- **The harm / legitimacy / grep meters** — per-item causal probes you can repoint at new questions.
- **Honesty discipline:** pre-registered kill criteria; publish the honest negative.

## Next steps (for the recipient)

1. **Read** [`docs/plans/2026-06-26-meta-evaluation-program.md`](plans/2026-06-26-meta-evaluation-program.md).
2. **Run candidate-discovery** — a ranked shortlist of high-value, harness-stress-testable agent-context/RAG
   claims (the workflow spec is in the program doc). Pick paper #2.
3. For each target: **operationalize on the harness → realism gate → honest result.**
4. **Decide positioning/venue** (sub-stack? paper series? a "claim leaderboard"?). Open question — see program doc.
5. **Optional, independent:** the `quality-then-publish` branch is publish-ready if you want to ship the
   engine to the privacy/air-gapped niche *as a tool*, regardless of the research line.

## Index of artifacts

**Handoff / program**
- `docs/RESEARCH-HANDOFF.md` — this file.
- `docs/plans/2026-06-26-meta-evaluation-program.md` — the forward research program.

**Strategic / design**
- `docs/plans/2026-06-24-quality-then-publish-design.md` — the (held) publish design.
- `docs/plans/2026-06-24-quality-then-publish.md` — the Q1–Q4 implementation plan (executed on `quality-then-publish`).
- `docs/plans/2026-06-25-harm-potential-design.md` — the harm-potential research design.

**Findings (the load-bearing honest results)**
- `benchmarks/FROZEN-CLAIM.md` — the canonical, honest engine claim (no universal winner; scoped edge).
- `benchmarks/COMMIT-DERIVED-FINDINGS.md` — the empirical ground truth.
- `benchmarks/GREP-HEADTOHEAD.md` — hybrid vs agentic-grep (wins at ≥10k files).
- `benchmarks/HARM-FINDINGS.md` — the harm-potential arc + the realism kill.

**Experiment scripts (all on `research/harm-potential`)**
- `benchmarks/harm-gate.ts`, `harm-gate-2.ts` — the E0 gate (synthetic confuser; GREEN).
- `benchmarks/harm-meter.ts` — E1 harm distribution by retrieval arm.
- `benchmarks/harm-policy.ts` — E3 naive policy (NEGATIVE).
- `benchmarks/harm-realism.ts` — R realism validation (real-code confusers → HP 0).
- `benchmarks/harm-multilang.ts` — M multi-language generalization.
- `benchmarks/harm-learned.ts` — L learned HP predictor (works on synthetic only).
- `benchmarks/legitimacy-eval.ts` — legitimacy-as-quality (NULL/hurts).

**Claude-internal memory** (session context, not human-facing): `~/.claude/projects/-home-ben-Documents-Projects-spacefolding/memory/` — `novel-research-pivot.md` (the strategic arc), `project-state.md`, `phase-8-grep-baseline.md`, `benchmark-harness-throughput.md`.

## The discipline (the real takeaway)
Every "novel advantage" in this arc was killed by the owner's own rigor before it became an over-claim.
That discipline — contamination-free harness, realism gates, pre-registered kill criteria, paired CIs,
publish-the-negative — is the genuinely rare, defensible thing here. The meta-evaluation program makes it
the product.
