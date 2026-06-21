#!/usr/bin/env bash
# Phase 8 grep head-to-head matrix runner (reproducible from a clean checkout).
#
# GPU SFR hybrid (structural) vs agentic-grep at 1k/10k/60k, seed 42, with the
# symbol-removed ablation run in the SAME harness (--symbol-removed). Each config
# is run twice: original queries + identifier-stripped queries, so the structural
# edge is always published alongside its collapse. Then analyze-grep-headtohead.ts
# computes tokens-to-first-correct-file (matched-context headline), recall@budget,
# the ablation column, and the paired-bootstrap crossover CI.
#
# Usage: bash benchmarks/run-grep-headtohead.sh [outdir] [extra evaluate args...]
# Defaults: outdir=/tmp/gh2h ; GPU on cuda:1, seed 42, retrieval depth 200.
set -euo pipefail

OUTDIR="${1:-/tmp/gh2h}"; shift || true
EXTRA_ARGS=("$@")
mkdir -p "$OUTDIR"

# Discipline: build before every eval run — evaluate.ts imports compiled dist/.
echo ">>> npm run build"; npm run build >/dev/null

export BENCH_EMBEDDING=gpu GPU_EMBEDDING_DEVICE=cuda:1 GPU_EMBEDDING_SEED=42 BENCHMARK_RETRIEVAL_DEPTH=200

run () { # <label> <dataset> <corpus> <maxfiles>
  local label="$1" dataset="$2" corpus="$3" maxfiles="$4"
  echo ">>> $label original (max-files $maxfiles)"
  npx tsx benchmarks/evaluate.ts --dataset "$dataset" --corpus "$corpus" \
    --max-files "$maxfiles" --strategy all --json "${EXTRA_ARGS[@]}" > "$OUTDIR/$label.json"
  echo ">>> $label ablation (--symbol-removed)"
  npx tsx benchmarks/evaluate.ts --dataset "$dataset" --corpus "$corpus" \
    --max-files "$maxfiles" --symbol-removed --strategy all --json "${EXTRA_ARGS[@]}" > "$OUTDIR/$label-ablated.json"
}

# django tops out at ~7k files → 1k only. typescript (81k) carries the 10k/60k scale axis.
run django-1k      /tmp/sf-commit-django.json     corpora/django     1000
run typescript-1k  /tmp/sf-commit-typescript.json corpora/typescript 1000
run typescript-10k /tmp/sf-commit-typescript.json corpora/typescript 10000
run typescript-60k /tmp/sf-commit-typescript.json corpora/typescript 60000

echo ">>> analyze"; npx tsx benchmarks/analyze-grep-headtohead.ts "$OUTDIR"/*.json
echo ">>> done → $OUTDIR"
