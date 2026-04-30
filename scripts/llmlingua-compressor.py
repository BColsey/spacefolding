#!/usr/bin/env python3
"""
LLMLingua Compression Subprocess

Provides token-level compression via LLMLingua as a JSON-RPC subprocess.
Spacefolding's TypeScript LlmLinguaCompressionProvider spawns this process
and communicates over stdin/stdout.

Usage: python3 scripts/llmlingua-compressor.py [--model <model_id>]

JSON-RPC protocol:
  Input:  {"id": 1, "method": "compress", "params": {"context": "...", "rate": 0.5}}
  Output: {"id": 1, "result": {"compressed": "...", "ratio": 0.5, "origin_tokens": 100, "compressed_tokens": 50}}
"""

import sys
import json
import argparse

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default='microsoft/llmlingua-2-xlm-roberta-large-meetingbank')
    args = parser.parse_args()

    # Lazy-load to avoid startup cost
    compressor = None

    def get_compressor():
        nonlocal compressor
        if compressor is None:
            try:
                from llmlingua import PromptCompressor
                compressor = PromptCompressor(model_name=args.model)
            except Exception as e:
                sys.stderr.write(f"Failed to load LLMLingua: {e}\n")
                sys.exit(1)
        return compressor

    sys.stderr.write(f"LLMLingua compressor ready (model={args.model})\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            sys.stderr.write(f"Invalid JSON: {line}\n")
            continue

        req_id = req.get('id', 0)
        method = req.get('method', '')

        if method == 'ping':
            print(json.dumps({'id': req_id, 'result': {'status': 'ok'}}))
            sys.stdout.flush()
            continue

        if method == 'compress':
            context = req.get('params', {}).get('context', '')
            rate = req.get('params', {}).get('rate', 0.5)

            try:
                comp = get_compressor()
                result = comp.compress_prompt(
                    context,
                    rate=rate,
                    force_tokens=[],
                )
                print(json.dumps({
                    'id': req_id,
                    'result': {
                        'compressed': result['compressed_prompt'],
                        'ratio': result.get('ratio', 0),
                        'origin_tokens': result.get('origin_tokens', 0),
                        'compressed_tokens': result.get('compressed_tokens', 0),
                    }
                }))
            except Exception as e:
                print(json.dumps({
                    'id': req_id,
                    'error': str(e),
                }))
            sys.stdout.flush()
            continue

        print(json.dumps({'id': req_id, 'error': f'Unknown method: {method}'}))
        sys.stdout.flush()


if __name__ == '__main__':
    main()
