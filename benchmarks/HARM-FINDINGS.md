# Harm-Potential — Findings (honest, 2026-06-26)

> Branch `research/harm-potential`. All experiments deterministic + offline. This doc records the
> measurement spine AND the realism validation that reframes the headline numbers.

## TL;DR (the honest pivot)

The localization-flip harm phenomenon measured in E0/E1 (structural **42.5%**, hybrid **31.3%**) is
**largely a synthetic artifact**. When confusers are REAL cross-project code files (Stream R), harm
collapses to **0.000** on both strategies — even for real files that lexically overlap the query and
that the retriever surfaces in the top-K. On a real multi-k-LOC corpus (Stream M), the structural-symbol
harm channel **does not generalize** (HP 0.03, n.s.); only the **FTS→hybrid** channel replicates (HP 0.60,
sig but n=5 / underpowered). The design's pre-registered kill criterion — *"kill if real-failure-mined
harm is undetectable"* — is **triggered at the localization-flip level.**

The harm meter is therefore best understood as an **adversarial stress test (worst-case bound on a
purpose-built poison)**, NOT a realism-calibrated estimate of field harm. Salvageable threads exist
(see below) but the "42% of correct localizations are flippable" framing is not ecologically valid.

## Experiments

| Exp | Script | Result |
|---|---|---|
| **E0** gate | `harm-gate-2.ts` | GREEN — synthetic confuser flips 42.5% structural / 31.3% hybrid (CI excl 0) |
| **E1** distribution | `harm-meter.ts` | harm is arm-specific: structural↔symbol, hybrid↔FTS (synthetic confusers) |
| **E2** orthogonality | — | DEFERRED to v2 — internal scores circular with flip (r=0.95 tautology) |
| **E3-naive** policy | `harm-policy.ts` | NEGATIVE — multi-arm corroboration no-op on structural, worse on hybrid (+17.9% recall cost) |
| **R** realism | `harm-realism.ts` | **NEGATIVE** — real-code confusers HP=0.000; positive control (synthetic) HP=0.406 (harness sound) |
| **M** multi-lang | `harm-multilang.ts` | MIXED — structural harm doesn't generalize (0.03 n.s.); FTS→hybrid does (0.60 sig, n=5) |
| **L** learned predictor | `harm-learned.ts` | QUALIFIED POSITIVE — graph-legitimacy predictor cuts SYNTHETIC-confuser flips (struct 28.7→6.1%, hybrid 33.3→17%) at ~0 recall cost; non-circular; but trained/tested on synthetic labels |

## What the realism result (R) means

- 540 real `.ts` confusers (from `corpora/typescript`, vscode, kibana), 120-task subset, 262 trials.
- **HP=0.000** for real confusers — structural (n=212) and hybrid (n=50), HIGH- and LOW-overlap subsets, all CIs [0,0].
- Real confusers ARE retrieved contenders (113/212 reached structural top-200 at median rank #20) — they just never outscore the gold file at rank-1.
- **Positive control:** the synthetic structural confuser through the *same* harness on the *same* 106 tasks = HP 0.406 (matches E1's 0.425). The null is genuine, not a broken experiment.
- Conclusion: realistic cross-project contamination (node_modules / vendored code) poses **negligible top-1 flip risk** to this retriever.

## What multi-language (M) means

- Real typescript-compiler corpus (38 files, ~108k LOC). Structural base recall 94.3%; **hybrid base recall collapsed to 14.3%** (vector arm diluted at scale — itself a v2 finding).
- structural-only confuser: HP 0.03 (n=33, n.s.) — **contradicts** E1's 42.5%; the structural harm was a small/flat-corpus artifact (real gold files are structurally rich; a synthetic single-symbol stub can't displace them).
- fts-only confuser on hybrid: HP 0.60 (CI [0.2,1], sig) — the one channel that **does** generalize, though n=5 (wide CI).

## What the learned predictor (L) means (qualified)

- A feature-based predictor REDUCES **synthetic**-confuser flips on held-out tasks (split BY task): structural 28.7%→6.1% (≈0 recall cost, AUC 0.78); hybrid 33.3%→17% (0 cost, AUC 0.70).
- **Non-circular:** a pilot including `final`/raw arm magnitudes gave AUC 0.81 tautologically (flip ≡ confuserFinal > goldFinal); after excluding them, the signal stays positive.
- The robust non-circular feature is **graph legitimacy** — demote candidates whose exported symbols have **zero inbound code-references** (isolated → suspect). Works as a simple interpretable rule, no training needed.
- **Caveat (load-bearing):** train/test share confuser *generators* (same synthetic types), and labels are synthetic injection flips, not realistic agent failures. Since realistic harm ≈ 0 (R), this policy is currently solving a largely synthetic problem.

## Salvageable threads (honest)

1. **FTS→hybrid is the one realistic harm channel** (M) — modest, underpowered; worth a powered re-test.
2. **Adversarial-bound reframe** — the harm meter is a valid worst-case/security stress test (can a purpose-built poison flip the localization?). Real but narrow value.
3. **Graph-legitimacy as a code-search quality feature** — "isolated exported symbols are suspect" is a real, non-circular, interpretable signal that may improve retrieval generally (independent of the harm thesis).
4. **v2 task-success** — the real ecological test: a confuser that doesn't flip *localization* may still mislead the agent's *edit*. Needs the verifier substrate (the deferred v2). This is where realistic harm could actually live.

## Recommendation

The localization-flip harm-potential thesis **did not survive realism validation**. Options: (a) reframe as an
adversarial-bound + code-search-quality contribution (graph legitimacy); (b) pivot to the **v2 task-success
verifier** to test realistic harm at the edit level (the real test); (c) treat as an honest negative result
and return to the other novel survivors (non-existence-as-failure-cause; negative-context/non-interference).

## Legitimacy-as-quality-feature (2026-06-26) — also NULL (option-a salvage tested + rejected)

`legitimacy-eval.ts`: does demoting zero-inbound-reference (isolated) exported symbols improve REAL Hits@1
(no confusers)? The graph-legitimacy feature from L, retested as a standalone quality signal.

- **structural:** baseline Hits@1 0.904 → hard-demote-isolated **0.860** (Δ **−0.044**, CI [−0.072, −0.020],
  **significantly HURTS** — real gold files sometimes have isolated entrypoint/exported symbols, so demoting
  them removes correct answers). Soft `score + λ·log1p(legit)` ≈ 0 across λ.
- **hybrid:** baseline 0.268 → hard-demote 0.288 (Δ +0.020, CI [−0.016, 0.056], n.s.); soft ≈ 0.

**Conclusion:** graph-legitimacy does **not** improve real retrieval quality. It only detected the
*synthetic-confuser* signature (an isolated symbol engineered to match a query), which is not a general
quality signal. The "salvageable code-search-quality feature" thread (option a) does **not** hold up under
realism either.

### Net state of the harm-potential direction

Every strong claim has collapsed under rigorous validation: E0/E1 harm = synthetic artifact (R); structural
harm = small-corpus artifact (M); the learned predictor + legitimacy feature solve only the synthetic
problem (L + this eval). Remaining value is limited to (i) the harm meter as an **adversarial worst-case
bound** (niche/security framing) and (ii) the **honest negative result** itself (realistic context noise
does not flip localization — contra the field's assumption). The "novel defensible advantage" goal has not
been met by this direction.
