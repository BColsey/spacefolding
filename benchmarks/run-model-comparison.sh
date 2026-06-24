#!/usr/bin/env bash
# WS0.4 (Phase 7) self-run model comparison driver.
#
# Runs evaluate.ts --strategy all at the shipped default chunk size (2000) and
# depth 200, on the contamination-free commit-derived tasks, under the GPU sidecar
# with each candidate embedding model. The lexical arms (bm25/fts/keyword) are
# model-independent -> a built-in control that the corpus/chunks are identical
# across models; only vector/structural move. Writes
#   $OUTDIR/{lang}-model-{tag}.json
#
# Replaces the contaminated 20-task self-corpus MODEL-COMPARISON.md with an
# external, self-run number so the shipped-default model choice rests on evidence.
#
# IMPORTANT: npm run build first. GPU sidecar (sentence-transformers) required.
#
# Usage: benchmarks/run-model-comparison.sh "<model-tags>" "<langs>"
#   model-tags: space-separated keys from the MODELS map below (sfr gte bgem3 bge)
#   langs:      django typescript
set -uo pipefail
cd "$(dirname "$0")/.."

MODELTAGS="${1:?model tags e.g. \"sfr gte bgem3 bge\"}"
LANGS="${2:?langs e.g. \"django typescript\"}"
OUTDIR="${OUTDIR:-/tmp/sf-cs}"
mkdir -p "$OUTDIR"

model_id() {
  case "$1" in
    sfr)   echo "Salesforce/SFR-Embedding-Code-400M_R" ;;  # shipped default (code, 1024d)
    gte)   echo "Alibaba-NLP/gte-modernbert-base" ;;        # code-specific (CoIR 79.31, 768d)
    bgem3) echo "BAAI/bge-m3" ;;                            # strong general (1024d)
    bge)   echo "BAAI/bge-small-en-v1.5" ;;                 # local-fallback model (384d)
    *) echo "" ;;
  esac
}

for tag in $MODELTAGS; do
  mid=$(model_id "$tag")
  [ -z "$mid" ] && { echo "unknown model tag: $tag"; continue; }
  for lang in $LANGS; do
    ds="/tmp/sf-commit-${lang}.json"; corpus="corpora/${lang}"
    [ -f "$ds" ] || { echo "MISSING $ds"; continue; }
    out="$OUTDIR/${lang}-model-${tag}.json"; err="$OUTDIR/${lang}-model-${tag}.err"
    echo "[$(date +%H:%M:%S)] $lang model=$tag ($mid) -> $out"
    start=$(date +%s)
    BENCH_EMBEDDING=gpu GPU_EMBEDDING_DEVICE="${GPU_EMBEDDING_DEVICE:-cuda:1}" GPU_EMBEDDING_SEED="${GPU_EMBEDDING_SEED:-42}" \
      GPU_EMBEDDING_MODEL="$mid" BENCHMARK_RETRIEVAL_DEPTH=200 CHUNK_MAX_TOKENS=2000 \
      npx tsx benchmarks/evaluate.ts --dataset "$ds" --corpus "$corpus" --strategy all --json \
      > "$out" 2> "$err"
    rc=$?; dur=$(( $(date +%s) - start ))
    if [ $rc -ne 0 ] || [ ! -s "$out" ]; then echo "  FAILED rc=$rc (${dur}s): $(tail -2 "$err"|tr '\n' ' ')"; continue; fi
    node -e '
      const r=require(process.argv[1]); const g=Object.fromEntries(r.strategies.map(s=>[s.strategy,s.averages]));
      const f=k=>g[k]?`${k} ${g[k].recallAt10.toFixed(3)}/${g[k].hitsAt1.toFixed(3)}`:`${k} --`;
      console.log("  "+["vector","structural","fts","bm25"].map(f).join(" | ")+` (${process.argv[2]}s)`);
    ' "$out" "$dur"
  done
done
echo "[$(date +%H:%M:%S)] model comparison done: [$MODELTAGS] [$LANGS]"
