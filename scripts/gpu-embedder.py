#!/usr/bin/env python3
"""GPU-accelerated embedding server for Spacefolding.

Runs as a subprocess, communicates via JSON-RPC over stdin/stdout.
Uses sentence-transformers with CUDA for fast batch embedding.

Usage:
  python3 scripts/gpu-embedder.py --model all-mpnet-base-v2 --device cuda

Protocol:
  Input:  JSON line {"id": 1, "texts": ["text1", "text2"], "batch": false}
  Output: JSON line {"id": 1, "embeddings": [[0.1, ...], [0.2, ...]], "dim": 768, "ms": 12.3}

  Special input: {"cmd": "ping"}
  Special output: {"cmd": "pong", "model": "...", "device": "cuda:0", "dim": 768}
"""

import sys
import json
import time
import argparse
import threading
from pathlib import Path

def main():
    parser = argparse.ArgumentParser(description='GPU embedding server for Spacefolding')
    parser.add_argument('--model', default='all-mpnet-base-v2', help='Sentence-transformer model name')
    parser.add_argument('--device', default='cuda', help='Device: cuda, cpu')
    parser.add_argument('--max-seq-length', type=int, default=None, help='Override max sequence length')
    args = parser.parse_args()

    # Load model
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        error({"error": "sentence-transformers not installed. Run: pip install sentence-transformers"})
        sys.exit(1)

    try:
        model = SentenceTransformer(args.model, device=args.device)
    except Exception as e:
        error({"error": f"Failed to load model '{args.model}': {e}"})
        sys.exit(1)

    if args.max_seq_length:
        model.max_seq_length = args.max_seq_length

    dim = model.get_sentence_embedding_dimension()
    device_name = str(model.device)

    # Signal ready
    write({"status": "ready", "model": args.model, "device": device_name, "dim": dim})

    # Process requests
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            error({"error": f"Invalid JSON: {e}"})
            continue

        # Ping
        if req.get("cmd") == "ping":
            write({"cmd": "pong", "model": args.model, "device": device_name, "dim": dim})
            continue

        # Embed
        req_id = req.get("id", 0)
        texts = req.get("texts", [])
        if not texts:
            write({"id": req_id, "embeddings": [], "dim": dim, "ms": 0})
            continue

        start = time.perf_counter()
        try:
            embeddings = model.encode(texts, convert_to_numpy=True, normalize_embeddings=True)
            elapsed_ms = (time.perf_counter() - start) * 1000
            write({
                "id": req_id,
                "embeddings": embeddings.tolist(),
                "dim": dim,
                "ms": round(elapsed_ms, 1),
            })
        except Exception as e:
            write({"id": req_id, "error": str(e)})


def write(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()


def error(obj):
    sys.stderr.write(json.dumps(obj) + '\n')
    sys.stderr.flush()


if __name__ == '__main__':
    main()
