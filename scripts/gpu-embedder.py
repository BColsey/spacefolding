#!/usr/bin/env python3
"""GPU-accelerated embedding server for Spacefolding.

Runs as a subprocess, communicates via JSON-RPC over stdin/stdout.
Uses sentence-transformers for high-quality batch embedding. CUDA is used when
available; pass --device cpu to run on CPU (the default code embedding model,
Salesforce/SFR-Embedding-Code-400M_R, is small enough to be CPU-feasible).

Usage:
  # GPU (recommended high-quality, code-specific default):
  python3 scripts/gpu-embedder.py --model Salesforce/SFR-Embedding-Code-400M_R --device cuda
  # CPU (no GPU required):
  python3 scripts/gpu-embedder.py --model Salesforce/SFR-Embedding-Code-400M_R --device cpu

Protocol:
  Input:  JSON line {"id": 1, "texts": ["text1", "text2"], "batch": false}
  Output: JSON line {"id": 1, "embeddings": [[0.1, ...], [0.2, ...]], "dim": 768, "ms": 12.3}

  Special input: {"cmd": "ping"}
  Special output: {"cmd": "pong", "model": "...", "device": "cuda:0", "dim": 768}
"""

import sys
import os
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
    parser.add_argument(
        '--seed',
        type=int,
        default=int(os.environ['GPU_EMBEDDING_SEED']) if os.environ.get('GPU_EMBEDDING_SEED') else None,
        help='Best-effort determinism seed (torch/cuda/cudnn). GPU inference still has residual '
             'non-determinism, so publishable claims must report mean+/-CI over multiple runs.',
    )
    # The recommended default (Salesforce/SFR-Embedding-Code-400M_R) ships custom
    # modeling code and fails to load without this. Defaults ON because the
    # documented default requires it; set GPU_EMBEDDING_TRUST_REMOTE_CODE=0 to opt
    # out (then only stock-architecture models will load).
    parser.add_argument(
        '--trust-remote-code',
        action='store_true',
        default=os.environ.get('GPU_EMBEDDING_TRUST_REMOTE_CODE', '1') not in ('0', 'false', 'False', ''),
        help='Allow models that ship custom code (required by e.g. SFR-Embedding-Code).',
    )
    args = parser.parse_args()

    # Best-effort determinism. GPU inference (cudnn autotuning, floating-point
    # atomics) is NOT bit-exact even with this set, so this only narrows run-to-run
    # variance. Publishable claims must still report mean+/-CI over several runs,
    # never a single seeded number.
    if args.seed is not None:
        try:
            import torch
            torch.manual_seed(args.seed)
            torch.cuda.manual_seed_all(args.seed)
            torch.backends.cudnn.deterministic = True
            torch.backends.cudnn.benchmark = False
        except ImportError:
            pass

    # Load model
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        error({"error": "sentence-transformers not installed. Run: pip install sentence-transformers"})
        sys.exit(1)

    try:
        try:
            model = SentenceTransformer(
                args.model, device=args.device, trust_remote_code=args.trust_remote_code
            )
        except TypeError:
            # Older sentence-transformers without the trust_remote_code kwarg.
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
