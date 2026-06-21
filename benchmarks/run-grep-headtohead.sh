#!/usr/bin/env bash
# Phase 8 grep head-to-head matrix runner (reproducible from a clean checkout).
#
# GPU SFR hybrid (structural) vs agentic-grep across repo scale, seed 42, with the
# symbol-removed ablation run in the SAME harness (--symbol-removed). Each config is
# run twice (original + identifier-stripped) so the structural edge is always shown
# alongside its collapse. Then analyze-grep-headtohead.ts computes tokens-to-first-
# correct-file (matched-context headline), recall@budget, the ablation column, and
# the paired-bootstrap crossover CI.
#
# SCALE AXIS (per-corpus — django/typescript are small; no single claim-language
# corpus reaches 60k under the source walker): django ~0.9k, typescript ~0.7k,
# rust ~6k, kubernetes ~9k. The only 60k corpus is kibana (TS), which is a depth-1
# shallow clone with no commit history → run-grep-headtohead regenerates its tasks
# only if the repo has history; otherwise kibana-60k is skipped (unshallow it first).
#
# Usage: bash benchmarks/run-grep-headtohead.sh [outdir]
set -euo pipefail

OUTDIR="${1:-/tmp/gh2h}"
mkdir -p "$OUTDIR"

echo ">>> npm run build"; npm run build >/dev/null
export BENCH_EMBEDDING=gpu GPU_EMBEDDING_DEVICE=cuda:1 GPU_EMBEDDING_SEED=42 BENCHMARK_RETRIEVAL_DEPTH=200

run () { # <label> <dataset> <corpus> [maxfiles]
  local label="$1" dataset="$2" corpus="$3" maxfiles="${4:-}"
  local cap=(); [ -n "$maxfiles" ] && cap=(--max-files "$maxfiles")
  echo ">>> $label original${maxfiles:+ (max-files $maxfiles)}"
  npx tsx benchmarks/evaluate.ts --dataset "$dataset" --corpus "$corpus" \
    "${cap[@]}" --strategy all --json > "$OUTDIR/$label.json"
  echo ">>> $label ablation (--symbol-removed)"
  npx tsx benchmarks/evaluate.ts --dataset "$dataset" --corpus "$corpus" \
    "${cap[@]}" --symbol-removed --strategy all --json > "$OUTDIR/$label-ablated.json"
}

# Achievable scale axis (each corpus at its full walked source-file count).
run django      /tmp/sf-commit-django.json     corpora/django      932
run typescript  /tmp/sf-commit-typescript.json corpora/typescript  710
run rust        /tmp/sf-commit-rust.json       corpora/rust        6279
run kubernetes  /tmp/sf-commit-kubernetes.json corpora/kubernetes  8779

# kibana-60k only if it has commit-derived tasks (needs full git history — the
# checked-out kibana is a depth-1 shallow clone by default).
if [ -f /tmp/sf-commit-kibana.json ] && node -e "process.exit(require('/tmp/sf-commit-kibana.json').tasks.length>0?0:1)"; then
  run kibana-60k /tmp/sf-commit-kibana.json corpora/kibana 60000
else
  echo ">>> SKIP kibana-60k: /tmp/sf-commit-kibana.json has no tasks (kibana is a depth-1 shallow clone)."
  echo "    To enable the 60k point: git -C corpora/kibana fetch --unshallow, then"
  echo "    npx tsx benchmarks/generate-commit-tasks.ts --repo corpora/kibana --output /tmp/sf-commit-kibana.json --max-commits 800 --limit 100"
fi

echo ">>> analyze"; npx tsx benchmarks/analyze-grep-headtohead.ts "$OUTDIR"/*.json
echo ">>> done → $OUTDIR"
