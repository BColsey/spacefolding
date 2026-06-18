# Storage scale findings

The Phase-1 "wins at scale" thesis is a scale claim, so the storage engine must
survive the 10k–60k-file range before the grep head-to-head (Phase 8) invests in
its harness. Two Phase-4 hardening properties are measured here:
**(1)** the engine ingests + serves large corpora, and **(2)** reopening a
populated DB no longer DROPs+rebuilds the `vec0` table (`getVectorIndexRebuildCount`
stays at 1 across reopen). Generated with `benchmarks/scale-benchmark.ts`
(deterministic hash embeddings — this measures the storage/index path, not
embedding quality; sqlite-vec KNN is active, not the brute-force fallback).

## Results (deterministic embeddings, sqlite-vec, single process)

| corpus (capped) | files | cold ingest | reopen | vec rebuild | vector search@20 | RSS |
|-----------------|------:|------------:|------:|------------:|-----------------:|----:|
| django (1k)        | 1,000  | 1.7s   | 2ms  | 1 | 1ms  | 121 MB |
| superset           | 5,658  | 13.5s  | 2ms  | 1 | 5ms  | 120 MB |
| kubernetes         | 12,805 | 32.9s  | 5ms  | 1 | 12ms | 150 MB |
| kibana (60k cap)   | 60,000 | 117.6s | 14ms | 1 | 46ms | 281 MB |

## What this establishes

1. **The P4 incremental-vec0 fix works at scale.** `vecRebuildCount` stays **1**
   at every size — reopening a 60k-vector DB no longer rebuilds it. Reopen time
   stays **2–14 ms** (sub-linear), where previously it re-inserted every vector
   (≈ cold-ingest time, ~118 s at 60k) on every startup. That was the launch
   blocker; it is resolved.
2. **The engine reaches 60k files.** Cold ingest scales ~linearly at ~2 ms/file
   (dominated by per-file deterministic embedding + chunk/FTS writes); 60k builds
   in ~2 min. Retrieval latency is flat-ish (1 → 46 ms top-20 KNN from 1k → 60k),
   and RSS stays bounded (121 → 281 MB). **No storage ceiling below 60k** — the
   Phase-8 "wins at scale" precondition is met.
3. **vec0 incremental persistence holds.** sqlite-vec's `vec0` virtual table is
   reused across reopenings at a constant dimension (see
   `src/storage/vector-index.ts`, meta table `spacefolding_vec_meta`); only a
   dimension change triggers a rebuild.

## Caveats

- Cold-ingest time is dominated by deterministic embedding + FTS writes, not the
  vec0 build (the vec0 hydrate-from-`chunk_embeddings` is a small fraction). With
  real GPU embeddings the embedding cost moves to the GPU; the storage path
  measured here is unchanged.
- Single-process, single-query latency. Real concurrent load / multi-query is not
  exercised here (out of scope for the scale-ceiling check).
- 60k was the largest tested (kibana capped). kibana's full ~110k and the 81k
  typescript / 60k rust corpora are expected to extrapolate linearly; confirming
  the >60k tail is a cheap follow-up.

## Reproduce

```sh
npm run build
npx tsx benchmarks/scale-benchmark.ts --corpus corpora/django    --max-files 1000
npx tsx benchmarks/scale-benchmark.ts --corpus corpora/superset
npx tsx benchmarks/scale-benchmark.ts --corpus corpora/kubernetes
npx tsx benchmarks/scale-benchmark.ts --corpus corpora/kibana     --max-files 60000
```
