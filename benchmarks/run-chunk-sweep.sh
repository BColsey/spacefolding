#!/usr/bin/env bash
# Chunk-size / AST sweep driver for WS0.5 (Phase 6).
#
# Runs evaluate.ts --strategy all at depth 200 for each chunk setting and writes
# one JSON report per config to $OUTDIR/{lang}-{provider}-{tag}.json, where {tag}
# encodes the chunk setting (e.g. 2000, 800, 500, 500-ast). Each config is a
# SEPARATE process because the chunker reads CHUNK_MAX_TOKENS at module load.
#
# IMPORTANT: run `npm run build` first — evaluate.ts imports the compiled dist/.
#
# Usage:
#   benchmarks/run-chunk-sweep.sh <provider> "<sizes>" "<langs>" [ast]
#   provider: det | gpu
#   sizes:    space-separated maxTokens, e.g. "2000 800 500"
#   langs:    space-separated, e.g. "django typescript rust"
#   ast:      pass "ast" to also set CHUNK_TREE_SITTER=1 (tag gets -ast suffix)
#
# Examples:
#   benchmarks/run-chunk-sweep.sh det "2000 800 500" "django typescript rust"
#   benchmarks/run-chunk-sweep.sh gpu "2000 800 500" "django typescript rust"
set -uo pipefail
cd "$(dirname "$0")/.."

PROVIDER="${1:?provider (det|gpu)}"
SIZES="${2:?sizes e.g. \"2000 800 500\"}"
LANGS="${3:?langs e.g. \"django typescript rust\"}"
AST="${4:-}"
OUTDIR="${OUTDIR:-/tmp/sf-cs}"
mkdir -p "$OUTDIR"

common_env=(BENCHMARK_RETRIEVAL_DEPTH=200)
if [ "$PROVIDER" = "gpu" ]; then
  common_env+=(BENCH_EMBEDDING=gpu GPU_EMBEDDING_DEVICE="${GPU_EMBEDDING_DEVICE:-cuda:1}" GPU_EMBEDDING_SEED="${GPU_EMBEDDING_SEED:-42}")
fi
ast_tag=""
if [ "$AST" = "ast" ]; then
  common_env+=(CHUNK_TREE_SITTER=1)
  ast_tag="-ast"
fi

for lang in $LANGS; do
  ds="/tmp/sf-commit-${lang}.json"
  corpus="corpora/${lang}"
  if [ ! -f "$ds" ]; then echo "MISSING dataset $ds — skipping $lang"; continue; fi
  for size in $SIZES; do
    tag="${size}${ast_tag}"
    out="$OUTDIR/${lang}-${PROVIDER}-${tag}.json"
    err="$OUTDIR/${lang}-${PROVIDER}-${tag}.err"
    echo "[$(date +%H:%M:%S)] $lang $PROVIDER maxTokens=$size ast=${AST:-off} -> $out"
    start=$(date +%s)
    env "${common_env[@]}" CHUNK_MAX_TOKENS="$size" \
      npx tsx benchmarks/evaluate.ts --dataset "$ds" --corpus "$corpus" --strategy all --json \
      > "$out" 2> "$err"
    rc=$?
    dur=$(( $(date +%s) - start ))
    if [ $rc -ne 0 ] || [ ! -s "$out" ]; then
      echo "  FAILED rc=$rc (${dur}s): $(tail -2 "$err" | tr '\n' ' ')"
      continue
    fi
    node -e '
      const r=require(process.argv[1]);
      const g=Object.fromEntries(r.strategies.map(s=>[s.strategy,s.averages]));
      const f=k=>g[k]?`${k} R@10 ${g[k].recallAt10.toFixed(3)} H@1 ${g[k].hitsAt1.toFixed(3)}`:`${k} MISSING`;
      console.log("  "+["structural","fts","bm25"].map(f).join(" | ")+` (${process.argv[2]}s)`);
    ' "$out" "$dur"
  done
done
echo "[$(date +%H:%M:%S)] sweep done: $PROVIDER [$SIZES] [$LANGS] ast=${AST:-off}"
