# Held-Out Retrieval Benchmarks

Held-out runs should use repositories outside this checkout. Generated
datasets, benchmark JSON, and profiler JSON are `/tmp` artifacts; do not commit
private corpora or generated task JSON from private codebases.

For the main local pass/fail gate, see [ACCEPTANCE.md](ACCEPTANCE.md).

Generate a temporary dataset:

```sh
npx tsx benchmarks/generate-heldout.ts \
  --corpus /path/to/other/repo \
  --output /tmp/spacefolding-heldout-repo.json \
  --limit 60
```

Run the normal retrieval comparison against that corpus:

```sh
npm run build
npx tsx benchmarks/evaluate.ts \
  --dataset /tmp/spacefolding-heldout-repo.json \
  --corpus /path/to/other/repo \
  --strategy all \
  --json > /tmp/spacefolding-heldout-eval.json
```

Profile ingest/index cost and retrieval latency on the same held-out corpus:

```sh
npx tsx benchmarks/profile-retrieval.ts \
  --dataset /tmp/spacefolding-heldout-repo.json \
  --corpus /path/to/other/repo \
  --strategy structural \
  --json > /tmp/spacefolding-heldout-profile.json
```

The profiler reports file/chunk/symbol/reference counts, total estimated corpus
tokens, SQLite footprint, ingest time, query latency percentiles, returned token
percentiles, returned chunk counts, memory usage, and the slowest queries.

Use these JSON fields when comparing runs:

- Ingest cost: `files`, `fileBytes`, `chunks`, `symbols`, `references`,
  `totalTokensEstimate`, `dbBytes`, `ingestMs`, and `ingestFilesPerSecond`.
- Retrieval latency: `queryMs.min`, `queryMs.p50`, `queryMs.p95`,
  `queryMs.max`, `queryMs.mean`, and `slowestQueries[].queryMs`.
- Returned context: `tokensReturned.*`, `chunksReturned.*`,
  `slowestQueries[].tokensReturned`, and `slowestQueries[].topPaths`.
- Memory: `memory.rss`, `memory.heapUsed`, and `memory.heapTotal`.

Notes:

- Generated task paths are relative to the Spacefolding checkout so they match
  the paths stored by `benchmarks/evaluate.ts`.
- `benchmarks/generate-heldout.ts` refuses to write generated held-out datasets
  inside this checkout. Keep task JSON, benchmark JSON, and profiler JSON under
  `/tmp`.
- Tests, fixtures, dependency directories, build outputs, and virtualenvs are
  skipped by default. Pass `--include-tests` to include test files.
- The generated dataset is deterministic for a given corpus and `--seed`.
- These tasks are symbol-definition retrieval checks. They are a first held-out
  signal, not a replacement for expert task sets on unfamiliar repos.
