#!/usr/bin/env bash
# Phase 8 grep head-to-head matrix runner — HARDENED (cache + multi-seed + dual-GPU).
#
# GPU SFR hybrid (structural) vs agentic-grep across repo scale × seeds, with the
# symbol-removed ablation in the SAME harness. Hardening over the naive runner:
#   * SF_BENCH_CACHE_DIR — the ablation pass + same-seed re-runs reuse the indexed DB
#     (skip the ~0.5s/file re-ingest). The original builds the cache; ablation is free.
#   * multi-seed loop (SEEDS) for CI robustness (GPU runs carry ~±0.02 Hits@1 noise).
#   * DEVICE arg so two instances run concurrently on cuda:0 / cuda:1.
#
# Each (corpus, scale, seed) runs original (builds cache) + ablation (cache hit).
# Scale axis is PER-CORPUS (django/typescript are small under the walker; kibana-TS
# is the only 60k corpus — unshallow it first, see below).
#
# Usage:
#   bash benchmarks/run-grep-headtohead.sh [DEVICE] [OUTDIR] [SEEDS]
#   defaults: DEVICE=cuda:1  OUTDIR=/tmp/gh2h  SEEDS="42 43 44"
# Dual-GPU: run two instances — one with cuda:0 (kibana 1k/10k) + one with cuda:1 (60k).
set -euo pipefail

DEVICE="${1:-cuda:1}"; OUTDIR="${2:-/tmp/gh2h}"; SEEDS="${3:-42 43 44}"
mkdir -p "$OUTDIR" /tmp/sf-cache

echo ">>> npm run build"; npm run build >/dev/null
export BENCH_EMBEDDING=gpu GPU_EMBEDDING_DEVICE="$DEVICE" BENCHMARK_RETRIEVAL_DEPTH=200 SF_BENCH_CACHE_DIR=/tmp/sf-cache

run () { # <label> <dataset> <corpus> <maxfiles> <seed>
  local label="$1" dataset="$2" corpus="$3" maxfiles="$4" seed="$5"
  export GPU_EMBEDDING_SEED="$seed"
  local cap=(); [ -n "$maxfiles" ] && cap=(--max-files "$maxfiles")
  local sfx=""; [ "$seed" != "42" ] && sfx="-s${seed}"
  echo ">>> $label$sfx original (seed $seed) $(date +%H:%M)"
  npx tsx benchmarks/evaluate.ts --dataset "$dataset" --corpus "$corpus" "${cap[@]}" \
    --strategy all --json > "$OUTDIR/${label}${sfx}.json"
  echo ">>> $label$sfx ablation (--symbol-removed, cache hit) $(date +%H:%M)"
  npx tsx benchmarks/evaluate.ts --dataset "$dataset" --corpus "$corpus" "${cap[@]}" \
    --symbol-removed --strategy all --json > "$OUTDIR/${label}${sfx}-ablated.json"
}

for seed in $SEEDS; do
  run django      /tmp/sf-commit-django.json     corpora/django      932    "$seed"
  run typescript  /tmp/sf-commit-typescript.json corpora/typescript  710    "$seed"
  run kubernetes  /tmp/sf-commit-kubernetes.json corpora/kubernetes  8779   "$seed"
  run kibana-1k   /tmp/sf-commit-kibana.json     corpora/kibana      1000   "$seed"
  run kibana-10k  /tmp/sf-commit-kibana.json     corpora/kibana      10000  "$seed"
  # kibana-60k: only if tasks exist (kibana needs `git fetch --unshallow` + regen first).
  if node -e "process.exit(require('/tmp/sf-commit-kibana.json').tasks.length>0?0:1)" 2>/dev/null; then
    run kibana-60k /tmp/sf-commit-kibana.json corpora/kibana 60000 "$seed"
  fi
done

echo ">>> analyze ($(date +%H:%M))"; npx tsx benchmarks/analyze-grep-headtohead.ts "$OUTDIR"/*.json
echo ">>> done → $OUTDIR"
