# Next-phase execution prompts (Phases 8 & 9)

> Copy-paste-ready prompts for a fresh ultracode / dynamic-workflow session to
> execute **Phase 8 (grep head-to-head)** and **Phase 9 (launch close-out)**.
> Each block is self-contained: it names the files to read, the current state, the
> deliverables, the hard-won disciplines, and the exit criteria. Written after
> Phases 1–7 landed on branch `next-phases-wave-a`. Authoritative roadmap:
> [`NEXT-PHASES.md`](./NEXT-PHASES.md); empirical ground truth:
> [`benchmarks/COMMIT-DERIVED-FINDINGS.md`](./benchmarks/COMMIT-DERIVED-FINDINGS.md)
> and [`benchmarks/FROZEN-CLAIM.md`](./benchmarks/FROZEN-CLAIM.md).

## Shared state (true as of this writing — re-verify, don't trust blindly)

- Branch `next-phases-wave-a`. Phases 1–7 landed (gate input honest; frozen
  3-language GPU claim; regime-robust **blocking** gate, now on a **frozen
  self-corpus** `benchmarks/fixtures/self-corpus.json` via `--corpus-snapshot`;
  storage hardened to 60k files; WS0.3 ranking cleanup; **chunk default kept at
  `maxTokens=2000`**, AST off — `benchmarks/CHUNK-SIZE-FINDINGS.md`; **model
  verified, SFR-Embedding-Code-400M_R kept** — `benchmarks/MODEL-VERIFICATION.md`).
- **The load-bearing asset:** the GPU `structural − fts` **Hits@1** edge
  (tokens-to-first-correct-file). It is exact-identifier lookup, collapses under
  the symbol-removed ablation, holds on **django + typescript only** (not rust).
  No universal winner; the hybrid is *competitive* on recall, not dominant.
- **Reusable tooling already built** (don't reinvent):
  - `evaluate.ts` per-task token-cost: `EvalResult.details.tokenCost`
    `{ tokensToFirstHit, totalTokens, avgChunkTokens, chunksReturned }` — currently
    populated **only** for spacefolding-backed strategies (structural/text/vector/
    hybrid). `tokensToFirstHit` = cumulative token estimate of the ranked chunk
    list up to the first relevant-file chunk = **tokens-to-first-correct-file**.
  - `benchmarks/paired-bootstrap.ts` exports `pairedDiffCI` / `bootstrapMeanCI`
    (seeded, the published CI procedure).
  - `benchmarks/analyze-chunk-sweep.ts` (cross-config paired CIs, matched by
    taskId) and `benchmarks/run-model-comparison.sh` are copyable patterns.
  - `evaluate.ts --corpus-snapshot <json>` ingests a frozen `{path,content}[]`
    corpus; `benchmarks/scale-benchmark.ts --corpus <dir> --max-files N` is the
    scale harness (`benchmarks/SCALE-FINDINGS.md`: engine reaches 60k, vec0
    persists across reopen).
  - `scripts/smoke-install.sh` (clean-install smoke on the local ONNX path).
- **Corpora** under `corpora/`: django (7,086 files), kubernetes (30,653), kibana
  (109,723), rust (37,022 / 1.4 GB — **slow**, ~2 h/GPU config), typescript,
  superset, vscode, spring-framework. The **1k/10k/60k** scale points come from
  the benchmark **walker filter + `--max-files` caps** (see `SCALE-FINDINGS.md`:
  django→1k, kubernetes→~12.8k, kibana cap→60k), NOT the raw counts above.
- **Commit-derived task sets:** `/tmp/sf-commit-{django,typescript,rust,kubernetes}.json`
  (regenerate via `benchmarks/generate-commit-tasks.ts` per
  `benchmarks/GPU-REPRODUCTION.md` if missing).
- **GPU regime:** `BENCH_EMBEDDING=gpu GPU_EMBEDDING_DEVICE=cuda:1
  GPU_EMBEDDING_SEED=42 BENCHMARK_RETRIEVAL_DEPTH=200`, model
  `Salesforce/SFR-Embedding-Code-400M_R` (cached). **Single-seed GPU runs carry
  ~±0.02 Hits@1 noise — report mean±CI over seeds, never a single number.**

---

## PROMPT — Phase 8: grep head-to-head (the launch artifact)

```
Work Phase 8 (the grep head-to-head — the launch proof) from NEXT-PHASES.md, on
branch next-phases-wave-a (Phases 1–7 landed). Read NEXT-PHASES.md "Phase 8",
IMPLEMENTATION-PLAN.md WS1.1/WS1.2/WS1.3, and these before starting:
benchmarks/FROZEN-CLAIM.md, COMMIT-DERIVED-FINDINGS.md, SCALE-FINDINGS.md,
GPU-REPRODUCTION.md, CHUNK-SIZE-FINDINGS.md, MODEL-VERIFICATION.md, and the
"Shared state" section of NEXT-PHASE-PROMPTS.md.

GOAL: Build the missing agentic-grep baseline and EMPIRICALLY FIND the repo-size
crossover where spacefolding's GPU hybrid beats grep — reframed around the metric
where the edge is real: tokens-to-first-correct-file (the Hits@1 edge), NOT recall.
The honest narrative is "where grep loses" = large/monorepo scale under
token-constrained parallel subagents — and that crossover must be FOUND, not assumed.

DELIVERABLES:
- A seeded, token-budgeted ripgrep baseline strategy added to evaluate.ts
  ALL_STRATEGIES: 3–5 multi-round rg rounds with deterministic query reformulation
  between rounds, capped at a token budget, recording tokens consumed and whether
  the gold file(s) surfaced. It MUST be open-sourced and tunable (a skeptic can
  adjust the rounds/budget) so the baseline can't be called rigged. NOTE: confirm
  how `rg` is provided — `which rg` was NOT satisfied in the dev env; for
  reproducible-from-clean-checkout, decide between a vendored binding
  (@vscode/ripgrep), a documented system-rg prerequisite, or a pure-JS fallback,
  and state the choice.
- Extend the existing tokenCost accounting (EvalResult.details.tokenCost) to the
  grep arm so tokens-to-first-correct-file is a first-class metric for grep too,
  alongside recall@budget, at the 1k/10k/60k sizes (scale-benchmark.ts --max-files
  caps; SCALE-FINDINGS.md).
- Run the GPU SFR hybrid (structural) vs grep at 1k/10k/60k under GPU, INCLUDING
  GPU rust, carrying the symbol-removed ablation column in the SAME invocation (the
  top-1 edge must never be published without its collapse shown alongside).
- benchmarks/GREP-HEADTOHEAD.md: the headline figure (tokens-to-first-correct-file
  AND recall@budget, hybrid vs grep, at 1k/10k/60k), the crossover repo-size
  (found, not assumed), with paired-bootstrap CIs (reuse pairedDiffCI from
  paired-bootstrap.ts). Report where grep WINS (small repos) honestly.
- (Lever) Gate-test a local cross-encoder rerank after retrieval (RerankerProvider
  + src/providers/deterministic-reranker.ts exist): ship ONLY if it improves Hits@1
  (paired CI excludes 0, no recall loss); else cut it and publish the negative.

NON-NEGOTIABLE DISCIPLINE (learned the hard way — do not skip):
1. `npm run build` before EVERY eval/GPU run — evaluate.ts imports compiled dist/.
   Stale dist = meaningless numbers.
2. GPU is non-deterministic, ~±0.02 Hits@1 noise. Report mean±CI over seeds; make
   every comparison CONTROLLED (the non-grep, non-chunk arms must reproduce — verify
   before trusting a delta as signal).
3. The load-bearing asset is the GPU structural−fts Hits@1 / tokens-to-first-
   correct-file edge. Do not erode it. The crossover must be FOUND: if no crossover
   exists (grep matches the hybrid even at 60k), that is a VALID, documented
   negative that triggers a positioning rethink — a cheap honest result, not a
   failure to bury. Surface it to the owner; do not force a win.
4. The Phase-3 blocking gate (`check-acceptance.ts --blocking-subset
   --retrieval-json …` on the FROZEN snapshot: evaluate.ts --corpus-snapshot
   benchmarks/fixtures/self-corpus.json) must stay green; the E2E floors
   (recall ≥0.70 / precision ≥0.25 / ≤13k tokens) must hold. Never lower a threshold.
5. The grep baseline must be a genuine agent's search, not a strawman — a
   rigged-baseline accusation kills the launch artifact. Adversarially review it.
6. No "beats every baseline" / "structural understanding" language. No recall win
   the data doesn't support. rust is excluded from the gated claim; rust corpus is
   huge (37k/1.4GB, ~2h/GPU config) — budget GPU time accordingly.

EXIT CRITERIA: evaluate.ts has a grep strategy producing tokens-to-first-correct-
file + recall@budget at 1k/10k/60k, reproducible from a clean checkout with the
ablation in the same run; the hybrid wins tokens-to-first-correct-file vs grep at
≥10k files (paired CI excludes 0) — OR no crossover is found and that triggers a
documented positioning rethink; the Phase-3 gate stays green and the E2E floors
hold. Commit per sub-result with clear messages; DO NOT push.

Use a subagent/workflow for the adversarial review of the grep baseline (the
rigged-baseline failure mode) and of any ship-the-reranker default change. Surface
the crossover result and any positioning implication to the owner rather than
deciding unilaterally. ultracode
```

---

## PROMPT — Phase 9: launch close-out (deps, MCP docs, distribution, plugin)

```
Work Phase 9 (launch close-out) from NEXT-PHASES.md, on branch next-phases-wave-a
(Phases 1–8 landed). Read NEXT-PHASES.md "Phase 9", IMPLEMENTATION-PLAN.md
WS2.1/2.2/2.3 + the product/positioning + risk-register sections, and these:
docs/decisions/adr-002-license-fsl.md, benchmarks/MODEL-VERIFICATION.md,
scripts/smoke-install.sh, docs/configuration.md, docs/integration-guide.md, and the
"Shared state" section of NEXT-PHASE-PROMPTS.md.

GOAL: Clear the non-benchmark blockers that would make a launch dishonest or
impossible — without ever overstating the claim. These gate the ship but don't
affect credibility, and are cheap under supervision.

ALREADY DONE — verify, do NOT redo or re-litigate:
- LICENSE is decided: FSL-1.1-ALv2 (docs/decisions/adr-002-license-fsl.md,
  commit 065efa4). Owner direction "monetize". Do not reopen.
- MCP config docs are already fixed: integration-guide.md references `.mcp.json` /
  `claude mcp add` (the old `.claude/settings.json` bug is gone). Confirm, move on.
- The clean-install smoke + regime-dependence docs landed in Phase 7
  (scripts/smoke-install.sh, docs/configuration.md regime note).

DELIVERABLES:
- Re-run `npm audit` FRESH and fix supervised. The old plan said 5 vulns
  (1 critical/2 high) but the current tree reports far fewer (≈1 low, esbuild via
  vitest) — report the ACTUAL current state, fix what's fixable, run the full suite
  (412 tests) after, review the lockfile diff, and pin if a transitive bump breaks
  the test runner. Document any remaining un-fixable transitive vuln.
- Distribution: smoke-test the npx/bin entrypoint; `npm pack` / publish DRY-RUN with
  a files allowlist (exclude corpora/, benchmarks/fixtures snapshots if large, tests).
  Make the install reproduce the BENCHMARKED model: auto-download the GPU code model
  (Salesforce/SFR-Embedding-Code-400M_R) as the documented "for the published
  numbers" path. The frictionless local default (Xenova/bge-small-en-v1.5) WORKS
  (scripts/smoke-install.sh) but is the weaker bge regime where the gate claim
  FAILS — distribution must state this honestly (the benchmark-vs-default gap from
  MODEL-VERIFICATION.md), not paper over it.
- Security blocker: add a real ingest-root allowlist — mcp/server.ts ingest tools
  accept any absolute path (an agent could ingest ~/.ssh); the CLI guard hardcodes
  /workspace. Fix or explicitly flag before any ship.
- (Larger, Phase-2 scope — confirm scope with owner first) Collapse the ~12–13 MCP
  tool surface (src/mcp/server.ts) to 2–3 + a composite get_context_for_task; make
  ingest_context.type a JSON-Schema enum; add readOnlyHint/destructiveHint; return a
  self-healing hint on empty index instead of bare []. Ship the hooks-driven
  SessionStart/PreCompact/PostToolUse Claude Code plugin so the MCP server is the
  engine, not the interface.

NON-NEGOTIABLE DISCIPLINE:
1. `npm run build` + `npm test` green after EVERY change; the frozen Phase-3
   blocking gate and the E2E floors stay green. Never lower a threshold.
2. License is DECIDED (FSL-1.1-ALv2) — do not reopen it.
3. The benchmark-vs-default gap is real and must stay honest: the published wins
   need the GPU SFR model. The shipped default must auto-download + verify that
   exact model, OR the published numbers must be scoped to it and NEVER claimed on
   the deterministic/bge fallback.
4. `npm publish`, `npm audit fix`, and any distribution step are OUTWARD-FACING and
   hard to reverse. A dry-run / `npm pack` is fine; an ACTUAL publish requires
   explicit owner go — confirm first, do not publish unilaterally.
5. The tool-surface collapse + plugin is a large, behavior-changing surface —
   confirm scope with the owner before starting it, and review any tool-contract
   change (agents depend on the current tool names).

EXIT CRITERIA: `npm audit` reports 0 critical/high (or each remaining one documented
as un-fixable transitive); integration-guide.md references `.mcp.json` (confirm);
a clean-machine install → index → first retrieval completes < 60s and reproduces a
published result on the shipped GPU default (or the docs scope the numbers to the
GPU regime honestly); the ingest-root allowlist exists; tool-surface collapse +
plugin shipped IF in agreed scope. Commit per sub-result; DO NOT `npm publish`
without explicit owner go-ahead. ultracode
```

---

## How to use

Paste one fenced block as the session prompt (keep the trailing `ultracode` to
opt into multi-agent orchestration). Each prompt tells the session to read the
files above first, commit per sub-result, not push, and surface owner decisions
(the crossover/positioning call in Phase 8; the publish go-ahead, tool-surface
scope, and any remaining vuln in Phase 9) rather than deciding unilaterally.
