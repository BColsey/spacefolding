# Per-item Causal Harm-Potential of Retrieved Context — Research Design

- **Date:** 2026-06-25
- **Status:** Approved (owner, 2026-06-25); feasibility gate PASSED. Next → writing-plans for the implementation plan.
- **Origin:** novel-direction brainstorming (a wider-novelty ideation round selected this as the one genuinely-novel survivor; the four retrieval directions + VCR-RETRIEVER were rejected as partially-scooped narrow gaps). See memory `novel-research-pivot.md`.
- **Gate artifacts:** `benchmarks/harm-gate.ts` (v1, weak FTS-only confuser — 1.3%, n.s.), `benchmarks/harm-gate-2.ts` (v2, realistic code confuser — GREEN, the load-bearing result).

## Motivation — the phenomenon

Every retrieval/eviction system in production optimizes a single objective: **helpfulness/relevance**. But retrieved context can **harm**: a relevant-looking item can flip an otherwise-correct agent outcome to incorrect. This is invisible to relevance-only systems — they have no quantity for it, no objective against it, and no way to evict on it. The harm-potential direction makes **per-item causal harm** a first-class, measured quantity, tests whether it is orthogonal to relevance, and turns retrieval/eviction into a two-objective (help vs harm) problem.

## Why it is novel (the gap that survived the gate)

No prior work (as of mid-2026) defines a **per-item causal harm quantity** for retrieved context, tests its **orthogonality to relevance**, or frames retrieval/eviction as a **help-vs-harm Pareto** problem. Closest prior art is adjacent, not occupying:
- *"When Context Hurts"* (arXiv 2605.04361) — demonstrates the harm phenomenon empirically (multi-agent design), but is **not** per-item, **not** an orthogonality test, **not** a policy.
- *Causal Agent Replay* (arXiv 2606.08275) — counterfactual attribution, but to **steps/agents**, not to context items.

(Rejected as partially-scooped narrow gaps: verifier-closed-loop retrieval — TENET 2509.24148; PA-grounded retrieval — SliceMate 2507.18957; context benchmark — ContextBench 2602.05892; learned eviction — AdaCoM 2605.30785 / KVP / ACON.)

## Feasibility gate — DONE, GREEN

`benchmarks/harm-gate-2.ts`. Deterministic provider, offline, **control = 0 flips**, **0 delete-leaks**. A realistic code confuser (a `.ts` chunk that defines the task's identifiers in a **wrong** file + embeds the query text — competes on the structural/symbol AND FTS arms) flips otherwise-**correct** top-1 localizations:

| Strategy | n correct baseline | confuser flips | harm lift | 95% CI | significant |
|---|---|---|---|---|---|
| **structural** | 226 | **96 (42.5%)** | 0.425 | [0.363, 0.491] | ✅ |
| **hybrid** | 67 | **21 (31.3%)** | 0.313 | [0.209, 0.433] | ✅ |
| vector | 10 | 0 | — | — | underpowered |

**Striking finding:** the project's own "durable edge" (structural top-1 localization — what `FROZEN-CLAIM.md` hangs its hat on) is the **most** harm-susceptible. The phenomenon is real, large, and far above noise. (v1 with an FTS-only `.txt` confuser was a deliberately weak test → 1.3%, n.s.; the realistic code confuser is the load-bearing result.)

## The framework (core contribution)

**`HP(c | task) = P(outcome flips correct→incorrect | inject c) − P(flip | control)`** — causal (a do-intervention), per-item, measured by the injection harness. Generalize the single confuser into a **harm taxonomy**, measuring HP per type:
- same-symbol-different-file (namesake collision)
- deprecated / stale version
- partial-overlap (right concept, wrong scope)
- cross-module confuser
- adversarial / poisoned context

## The scientific thesis — orthogonality of harm to relevance

Is `HP(c)` **correlated** with `helpfulness/relevance(c)`, or **orthogonal**? **Two-sided bet — the paper lands either way:**
- **Orthogonal** → relevance is the *wrong objective* for eviction (a strong, falsifiable scientific claim that invalidates the relevance-only default).
- **Correlated** → the **harm-aware policy** still contributes, because no current system models harm at all.

## The constructive contribution

A **harm-aware two-objective (help vs harm) Pareto retrieval/eviction policy** vs the relevance-only baseline, demonstrating flip-recovery on the 31–42% of outcomes the relevance-only policy loses.

## Assets reused (the moat)

- **Injection HP-meter** — `harm-gate-2.ts` generalized into a reusable per-item harm probe.
- **Commit-derived benchmark** (django/typescript/rust) — real tasks with real gold, contamination-free.
- **Symbol-removed ablation harness** — isolates symbol-vs-prose harm channels; directly explains *why* structural is 42%-susceptible.
- **Paired-bootstrap CIs** — statistical credibility for a noisy flip signal.

## Experiments

- **E0 (DONE):** feasibility gate — harm is real + large (above).
- **E1:** characterize the harm distribution — `HP × confuser-type × strategy × language` on commit-derived tasks. Headline number: 42% of correct localizations on the SOTA-localization strategy are flippable by a single harmful item.
- **E2:** the orthogonality test — `HP(c) ⊥ relevance(c)`? (Pre-register before running.)
- **E3:** harm-aware policy vs relevance-only baseline; measure flip-recovery + the help/harm Pareto frontier.

## Resolved decisions (owner, 2026-06-25)

1. **Outcome depth:** localization-flip for v1/paper-1 (measurable now, **proven**); the task-success verifier substrate (TENET-style; does not yet exist in-repo) as **v2**.
2. **Scope:** one tight paper (E1 + E2 + E3); "non-existence as a failure cause" deferred to a possible second paper.

## Paper shape / venue

Measurement + mechanism paper. Venue targets: **ICSE** (software eng.), **ACL**, or **NeurIPS** (retrieval / agents track). Hook: *42% of correct code localizations on the strongest localization strategy are flipped by a single relevant-but-wrong context item; harm is [orthogonal|correlated] to relevance; a harm-aware policy recovers N%.* Cite-and-contrast CAR (2606.08275) and "When Context Hurts" (2605.04361) explicitly.

## Risks / honesty / kill criteria

- **Confusers are currently semi-synthetic** → MUST validate with **real harmful items mined from actual agent failures** (not only constructed confusers) before claiming ecological validity. **Kill if real-failure-mined harm is undetectable.**
- **Localization-flip is a proxy** for task-success (weaker outcome); the v2 verifier strengthens it.
- **Scoop watch:** a CAR follow-up adding a context-item mode is the exposure; differentiate aggressively (we own the **orthogonality thesis + harm-aware policy**, not do-intervention step attribution). Set a literature watch + pre-decided trigger.
- **Pre-register E2** (orthogonality) before running; publish the honest negative if it fails — the project's documented discipline (`FROZEN-CLAIM.md`) applies.

## Deferred (v2 / second paper)

- **Task-success verifier substrate** — extend `HP` from "flips the localization" to "flips a verified-correct edit" (build the pre-patch-tree + scoped-test verifier; the contamination-free commit substrate uniquely enables it).
- **Non-existence as a failure cause** — distinguish retrieval-miss vs corpus-gap vs content-error; synthesize a counterfactual "what the absent item should have said" card. Genuinely novel; possible second paper.

## Artifacts

- `benchmarks/harm-gate.ts` — v1 (weak FTS-only confuser; 1.3% n.s. — kept as the conservative baseline).
- `benchmarks/harm-gate-2.ts` — v2 (realistic code confuser; GREEN — the load-bearing gate).
- Memory: `novel-research-pivot.md` (the strategic verdict + direction resolution).
