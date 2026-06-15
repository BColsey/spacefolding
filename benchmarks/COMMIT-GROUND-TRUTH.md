# Commit-derived ground truth (WS0.6)

`benchmarks/generate-commit-tasks.ts` mines real git history into retrieval
ground truth, replacing the circular `generate-heldout.ts` templates
("where is `{symbol}` defined") that let structural retrieval win by
construction.

## What it produces

For each qualifying commit:

- **query** = the commit / PR message (conventional-commit prefix and footer
  trailers stripped, subject + first body paragraph, length-capped) — the text a
  user would actually type when asking for the change.
- **relevant_files** = the **code** files the patch touched, that still exist in
  the working tree (so they are actually indexed), as repo-root-relative paths
  matching how `evaluate.ts --corpus` ingests.
- **task_symbol_removed** = a symbol-removed ablation of the query (see below).

## Credibility guards

| Guard | Rule | Why |
|-------|------|-----|
| **Anti-leakage** | Drop the task if the message literally names any changed file — full path, basename+extension, or a distinctive (code-shaped) basename. | A message that names the file makes retrieval a string-match gimme. Naming a *class* is **not** naming a file — that is handled by the ablation, not exclusion. |
| **Symbol-removed ablation** | Each task also carries a variant where exact identifiers (backticked code, names defined in the touched files, clearly code-shaped tokens) are replaced by behavioral placeholders. | Publishing the original-vs-ablated gap quantifies how much of structural's win is genuine retrieval vs. exact-identifier lookup. |
| **Size filter** | Keep only commits touching `[--min-files, --max-files]` code files (default 1–5). | Mega-refactors dilute precision and don't model "find the file for this change." |
| **No-merges by default** | `--no-merges` (override with `--include-merges`). | Merge commits carry combined diffs and no single descriptive message. |

The summary reports every exclusion bucket (`excludedNamedFile`,
`excludedSize`, `excludedNoCodeFiles`) and the ablation count — nothing is
silently dropped.

## Usage

The `corpora/*` repos are checked out **depth-1** (one commit, no history).
Deepen the one you want to mine first, then generate:

```bash
# 1. Obtain commit history (network + disk; corpora/ is gitignored)
git -C corpora/django fetch --deepen=2000

# 2. Generate the dataset (writes to /tmp only, like generate-heldout.ts)
npx tsx benchmarks/generate-commit-tasks.ts \
  --repo corpora/django \
  --output /tmp/spacefolding-commit-django.json \
  --max-commits 2000 --limit 100

# 3. Evaluate against the same corpus (BM25 + fts + structural baselines)
npx tsx benchmarks/evaluate.ts \
  --dataset /tmp/spacefolding-commit-django.json \
  --corpus corpora/django \
  --strategy all --json > /tmp/spacefolding-commit-django-eval.json
```

The generator can be run against **any** git repo, including spacefolding
itself (`--repo .`) — which is how its test suite exercises it without a clone.

## Options

| Flag | Default | Meaning |
|------|---------|---------|
| `--repo <dir>` | project root | git repo to mine; also the path-convention root |
| `--output <path>` | `/tmp/spacefolding-commit-dataset.json` | output JSON (must be under `/tmp`) |
| `--max-commits <N>` | 400 | history window to scan |
| `--limit <N>` | 100 | max tasks to emit |
| `--min-files <N>` / `--max-files <N>` | 1 / 5 | code-file count bounds per commit |
| `--include-tests` | off | keep test files in the relevant set |
| `--include-merges` | off | include merge commits |
| `--seed <s>` | `commit` | deterministic irrelevant-file sampling |

## Output schema

Compatible with both `evaluate.ts` and `e2e-benchmark.ts`. Each task:

```jsonc
{
  "id": "C001",
  "task": "Improve fusion weighting in the hybrid scorer. ...",
  "task_symbol_removed": "Improve fusion weighting in the relevant component. ...",
  "removed_symbols": ["HybridRetriever"],
  "intent": "code_search",
  "relevant_files": ["src/core/retriever.ts", "src/core/scorer.ts"],
  "relevant_types": ["code"],
  "relevant_keywords": ["fusion", "weighting", "hybrid", "scorer"],
  "irrelevant_files": ["..."],
  "source": "commit-derived",
  "commit": { "hash": "...", "subject": "...", "files_touched": 2 }
}
```

## Still pending (post-fetch — see `NEXT-STEPS.md` Step 1)

- Generate datasets across the deepened corpora; report per-corpus bootstrap CIs.
- Wire the BM25/`fts` baselines into `check-acceptance.ts` (replace the strawman
  keyword comparison).
- **Pre-register** the E2E thresholds on a calibration split and evaluate on
  disjoint tasks with a noise margin — replacing the reverse-engineered
  0.95 / 0.35 magic numbers — before the gate is flipped to blocking.
- Publish the symbol-removed ablation gap.
