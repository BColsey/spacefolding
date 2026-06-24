# E2E Benchmark Results — RETIRED (pre-decontamination self-corpus)

> **Do not cite these numbers.** This file reported focused-retrieval E2E metrics on
> Spacefolding's own codebase *before* the query-expansion contamination was removed
> (WS0.2). The recall `0.967` figure and the `>= 0.950` / `>= 0.350` acceptance
> thresholds were reverse-engineered from that contaminated system and are **not
> reproducible** on the clean stack.

The implemented acceptance floors (in `benchmarks/check-acceptance.ts` and
`benchmarks/e2e-benchmark.ts`) are the honest **recall ≥ 0.70**, **precision ≥ 0.25**
— measured at depth=200 with deterministic (hash) embeddings, where the vector arm is
≈ random (see [`COMMIT-DERIVED-FINDINGS.md`](./COMMIT-DERIVED-FINDINGS.md)). The
composite retrieval gate is non-inferior to the strongest lexical baseline on
recall@10 AND strictly beats FTS on Hits@1; that composite claim is regime-dependent
(holds on the GPU code-embedding model, fails honestly on the deterministic provider
used in CI).

## Current, honest numbers

See [`COMMIT-DERIVED-FINDINGS.md`](./COMMIT-DERIVED-FINDINGS.md) for the
commit-derived results and the explanation of why deterministic E2E measures lower
than the retired `0.967`.

## Reproduction (historical command, reference only)

```sh
# NOTE: deterministic E2E on the self-corpus measures ~0.80 recall, not 0.967.
npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json > /tmp/spacefolding-e2e.json
```
