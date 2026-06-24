# Benchmark Results — RETIRED (pre-decontamination self-corpus)

> **Do not cite these numbers.** This file reported retrieval metrics on
> `benchmarks/dataset.json` — the legacy self-corpus generated from Spacefolding's
> *own* source via `generate-tasks.ts`, graded at retrieval depth 20, *before* the
> hardcoded query-expansion contamination was removed (WS0.2) and before the
> file-level BM25F baseline and fair depth=200 retrieval were added (WS0.6).
>
> The figures that lived here (Structural R@10 `0.958` / R@20 `1.000`) were inflated
> by the contamination and the shallow retrieval cap and are **not reproducible** on
> a clean, commit-derived benchmark. They are retained in git history only.

## Current, honest numbers

All current retrieval results live in
[`COMMIT-DERIVED-FINDINGS.md`](./COMMIT-DERIVED-FINDINGS.md): commit-derived tasks
across django / typescript / rust, fair depth=200, a file-level BM25F baseline,
paired-bootstrap 95% CIs, and a symbol-removed ablation. The honest headline:
**there is no universal winner** — the recalibrated hybrid is competitive with the
strongest lexical baselines and wins top-1 localization (Hits@1) over FTS, but does
not dominate a correct BM25 on recall.

## Reproduction (historical command, reference only)

```sh
# NOTE: this regenerates the RETIRED self-corpus numbers, NOT the current
# commit-derived findings. Use generate-commit-tasks.ts for current ground truth.
npx tsx benchmarks/evaluate.ts --strategy all --json > /tmp/spacefolding-eval.json
```
