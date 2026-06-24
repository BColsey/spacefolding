#!/usr/bin/env bash
# Clean-install smoke test (WS0.4 / Phase 7).
#
# Verifies the FRICTIONLESS install path end-to-end on the default local ONNX
# model (Xenova/bge-small-en-v1.5, no GPU, no Python sidecar): download the model,
# ingest a small tree, and retrieve a query — asserting the expected files surface.
#
# This is the regime a first-run user gets with `npx ... download-model`. NOTE the
# honest regime gap: this local path WORKS (correct files rank top) but does NOT
# reproduce the PUBLISHED GPU numbers — the composite acceptance claim (structural
# strictly beats FTS on Hits@1) holds only on the GPU code model
# (Salesforce/SFR-Embedding-Code-400M_R). To reproduce a published GPU result,
# use the GPU sidecar per benchmarks/GPU-REPRODUCTION.md. See
# benchmarks/MODEL-VERIFICATION.md and docs/configuration.md for the regime
# dependence.
#
# Usage: scripts/smoke-install.sh
set -uo pipefail
cd "$(dirname "$0")/.."

DB="${SMOKE_DB:-/tmp/sf-smoke-install.db}"
QUERY="how is oversized text split into sub-chunks at code boundaries"
EXPECT="chunker.ts"        # the chunker must surface for this query
CORPUS="${SMOKE_CORPUS:-src/core}"

rm -f "$DB" "$DB"-* 2>/dev/null || true
echo "[1/3] download-model (default local ONNX model)"
EMBEDDING_PROVIDER=local node dist/main.js download-model >/dev/null 2>&1 || { echo "FAIL: download-model"; exit 1; }

echo "[2/3] ingest $CORPUS (local provider)"
EMBEDDING_PROVIDER=local node dist/main.js --db "$DB" ingest-project "$CORPUS" >/dev/null 2>&1 || { echo "FAIL: ingest"; exit 1; }

echo "[3/3] retrieve + assert '$EXPECT' surfaces"
out=$(EMBEDDING_PROVIDER=local node dist/main.js --db "$DB" retrieve --query "$QUERY" --strategy structural --top-k 20 2>/dev/null)
echo "$out" | grep -iE "\[(HOT|WARM|COLD)\]" | head -5 | sed 's/^/    /'

if echo "$out" | grep -qi "$EXPECT"; then
  echo "PASS: frictionless local install path works ('$EXPECT' retrieved for the query)."
  echo "NOTE: published GPU numbers require the SFR code model — see benchmarks/GPU-REPRODUCTION.md."
  rm -f "$DB" "$DB"-* 2>/dev/null || true
  exit 0
else
  echo "FAIL: expected '$EXPECT' in retrieval results."
  exit 1
fi
