#!/usr/bin/env bash
# AST-chunking sweep driver for WS0.5 (Phase 6) — pure-JS web-tree-sitter path.
#
# Runs evaluate.ts at one or more chunk sizes with the pure-JS AST splitter ON
# (CHUNK_TREE_SITTER=js) and OFF (regex control), so AST-on vs AST-off is a
# controlled comparison on the SAME built dist (only the chunk-boundary source
# differs; ingest-time symbol extraction stays regex-fallback in both). Writes
#   {lang}-{provider}-{size}-jsast.json   (AST on)
#   {lang}-{provider}-{size}-regex.json   (AST off control, same dist)
#
# IMPORTANT: build first (npm run build) AND have web-tree-sitter + tree-sitter-wasms
# installed (npm install --no-save web-tree-sitter@0.20.8 tree-sitter-wasms@0.1.13).
#
# Usage: benchmarks/run-ast-sweep.sh <provider> "<sizes>" "<langs>"
set -uo pipefail
cd "$(dirname "$0")/.."

PROVIDER="${1:?provider (det|gpu)}"
SIZES="${2:?sizes e.g. \"500\"}"
LANGS="${3:?langs e.g. \"django typescript rust\"}"
OUTDIR="${OUTDIR:-/tmp/sf-cs}"
mkdir -p "$OUTDIR"

base_env=(BENCHMARK_RETRIEVAL_DEPTH=200)
if [ "$PROVIDER" = "gpu" ]; then
  base_env+=(BENCH_EMBEDDING=gpu GPU_EMBEDDING_DEVICE="${GPU_EMBEDDING_DEVICE:-cuda:1}" GPU_EMBEDDING_SEED="${GPU_EMBEDDING_SEED:-42}")
fi

run() {
  local lang="$1" size="$2" tag="$3"; shift 3
  local ds="/tmp/sf-commit-${lang}.json" corpus="corpora/${lang}"
  local out="$OUTDIR/${lang}-${PROVIDER}-${size}-${tag}.json"
  local err="$OUTDIR/${lang}-${PROVIDER}-${size}-${tag}.err"
  [ -f "$ds" ] || { echo "MISSING $ds"; return; }
  echo "[$(date +%H:%M:%S)] $lang $PROVIDER size=$size $tag -> $out"
  local start; start=$(date +%s)
  env "$@" "${base_env[@]}" CHUNK_MAX_TOKENS="$size" \
    npx tsx benchmarks/evaluate.ts --dataset "$ds" --corpus "$corpus" --strategy all --json \
    > "$out" 2> "$err"
  local rc=$? dur; dur=$(( $(date +%s) - start ))
  if [ $rc -ne 0 ] || [ ! -s "$out" ]; then echo "  FAILED rc=$rc: $(tail -2 "$err"|tr '\n' ' ')"; return; fi
  node -e '
    const r=require(process.argv[1]); const g=Object.fromEntries(r.strategies.map(s=>[s.strategy,s.averages]));
    const f=k=>g[k]?`${k} R@10 ${g[k].recallAt10.toFixed(3)} H@1 ${g[k].hitsAt1.toFixed(3)}`:`${k} MISSING`;
    console.log("  "+["structural","fts","bm25"].map(f).join(" | ")+` (${process.argv[2]}s)`);
  ' "$out" "$dur"
}

for lang in $LANGS; do
  for size in $SIZES; do
    run "$lang" "$size" "regex"  CHUNK_TREE_SITTER=0
    run "$lang" "$size" "jsast"  CHUNK_TREE_SITTER=js
  done
done
echo "[$(date +%H:%M:%S)] AST sweep done: $PROVIDER [$SIZES] [$LANGS]"
