# Meta-Evaluation Program — the forward research direction

> **Date:** 2026-06-26 · **Status:** chosen direction (owner). Companion to [`docs/RESEARCH-HANDOFF.md`](../RESEARCH-HANDOFF.md).

## The reframe

Three rounds of chasing a "novel mechanism" in agent-context-for-coding collapsed under rigor (scooped or
non-replicating). The genuine, proven strength is **rigorous honesty/evaluation methodology**. This program
makes that the contribution: **stress-test widely-believed agent-context / RAG claims** with the
contamination-free harness + realism gates, and publish the honest result (confirm / debunk / nuance).

Why it fits:
- the **asset stack is already built** (commit-derived benchmark, symbol-removed ablation, paired CIs,
  realism-gate pattern, the harm/legitimacy meters);
- the field is **full of over-claims waiting to be stress-tested**;
- "we found X doesn't hold under realistic test" is a **legitimate, citable, defensible** contribution —
  no novelty arms race, no incumbent fast-follow;
- it sidesteps the saturated mechanism-space.

## The pipeline (per claim)

1. **Pick** a widely-believed, stress-testable claim.
2. **Operationalize** it on the harness (define the outcome metric + the realistic input regime).
3. **Realism gate** — positive control (a known effect must reproduce) + real-data validation (does the
   effect survive realistic inputs, not synthetic/idealized ones?).
4. **Pre-register** the test + the kill criterion BEFORE running.
5. **Result** — confirm / debunk / nuance, with paired-bootstrap CIs.
6. **Write up** — short note; cite-and-contrast the closest prior art.

## Paper #1 — DONE

**Claim stress-tested:** *"retrieved context that is relevant-but-wrong causes serious harm (flips correct
agent outcomes)."* **Result:** at the **localization-flip** level, realistic cross-project code confusers
cause **HP ≈ 0** (control 0; positive-control synthetic confuser 0.406 → harness sound). The widely-cited
harm phenomenon is largely a **synthetic artifact** at this outcome level. Realistic context noise does not
flip code localization — **contra the field's assumption.** Full record: `benchmarks/HARM-FINDINGS.md`.
(Honest open thread: the **task-success** level — does a non-flipping confuser still mislead the *edit*? —
remains untested; rated low-prior but is the one v2 follow-up.)

## Paper #2 — SELECTED CANDIDATE

**Claim to stress-test:** *"cross-encoder rerankers reliably improve code
localization."* This is selected as the next candidate because it is
harness-ready, timely, and narrow enough to test without adding an edit-success
verifier. The claim is not accepted yet. The pre-registration stub lives in
`benchmarks/claims/reranker-reliability.json` and must pass:

```bash
npx tsx benchmarks/claim-protocol.ts benchmarks/claims/reranker-reliability.json
```

Minimum test shape:
- compare structural retrieval with and without the cross-encoder reranker;
- include an oracle-reranker positive control;
- run commit-derived django/typescript/rust tasks plus symbol-removed ablations;
- include at least one large-corpus scale case;
- report Hits@1, Recall@10, NDCG@10, MRR, and tokens-to-first-correct-file with paired CIs;
- debunk the reliability claim if reranking cannot improve both Hits@1 and
  tokens-to-first-correct-file without a Recall@10 regression in the declared
  regimes.

## Candidate claims for paper #2+ (shortlist to be ranked)

Each is widely repeated and stress-testable with the existing harness:

- **"Long context obviates retrieval"** (the "RAG is dead" claim). Does it, on real code tasks with real
  token budgets? Where is the context-rot crossover on actual code?
- **"Cross-encoder rerankers reliably improve code localization."** Selected as paper #2 candidate; not run yet.
- **"AST/structural chunking beats naive chunking."** Measurably, with CIs, on real corpora?
- **"More retrieved context monotonically helps agents."** Find the rot crossover on code.
- **"Context compression is lossless-enough for code tasks."** Does it silently drop the load-bearing
  identifier? (Restorable-compression angle.)
- **"Hybrid RAG beats plain FTS/BM25 for code."** The repo's own FROZEN-CLAIM already nuances this —
  package it as the meta-evaluation paper.

## Methodology recipe (the rigor that is the product)

- **Contamination-free tasks:** commit-derived (real commits; anti-leakage; symbol-removed ablation).
- **Realism gate (mandatory):** (a) positive control — a *known* effect must reproduce on the same harness
  (e.g., the synthetic confuser in the harm work); (b) real-data validation — switch from synthetic/idealized
  inputs to realistic ones (real files, real noise) and check the effect survives. **A claim that only holds
  on synthetic inputs is an adversarial bound, not a field result** — say so.
- **Paired-bootstrap CIs** on every effect; report the CI, not just the point estimate.
- **Pre-registration + kill criterion:** state the test and the "this would falsify it" condition before running.
- **Publish the honest negative.** (The discipline that makes this line defensible.)

## Candidate-discovery (next action before paper #2 write-up)

Run a workflow to produce a **ranked shortlist** of claims:
- **research** what the field currently asserts (papers, engineering blogs, product marketing, HN/reddit
  consensus) for coding-agent context / RAG;
- **score** each claim on: stress-testability-with-your-harness × impact-if-debunked × realism-gate feasibility;
- **return** a ranked top-N with the closest prior art + a one-line operationalization + the kill criterion for each.
Use it to validate or replace the reranker-reliability candidate before the
paper is written. If reranker reliability stays selected, copy exact primary
citations into the manifest before running the final experiment.

## Open positioning questions (decide before publishing paper #2)

- **Venue/form:** short arXiv notes? a sub-stack/"agent-context claim lab"? a living leaderboard of
  debunked/confirmed claims? a paper series?
- **Branding:** the "honesty/realism-gate" methodology is the moat — name it (e.g., a realism-gate protocol
  others can apply).
- **Cadence:** one claim per ~1–2 weeks (each is a focused experiment on existing infra).

## What NOT to do

- Do not chase a novel *mechanism* in agent-context-for-coding (saturated; 3 rounds failed).
- Do not publish a claim stress-test without the realism gate + positive control (that's how the harm
  artifact happened).
- Do not over-claim a negative into a positive ("we proved X is harmless" — you showed it's harmless *at
  one outcome level under one realism regime*; scope it).
