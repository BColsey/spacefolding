# Held-Out Retrieval Benchmarks

Held-out runs should use repositories outside this checkout and should not
commit generated datasets from private codebases.

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
  --json
```

Notes:

- Generated task paths are relative to the Spacefolding checkout so they match
  the paths stored by `benchmarks/evaluate.ts`.
- Tests, fixtures, dependency directories, build outputs, and virtualenvs are
  skipped by default. Pass `--include-tests` to include test files.
- The generated dataset is deterministic for a given corpus and `--seed`.
- These tasks are symbol-definition retrieval checks. They are a first held-out
  signal, not a replacement for expert task sets on unfamiliar repos.
