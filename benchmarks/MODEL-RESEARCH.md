# Embedding Model Research for Code Search/Retrieval

**Date:** 2026-04-26
**Current Best:** all-mpnet-base-v2 (CUDA, 768-dim) — R@10 = 0.729
**Keyword Baseline:** R@10 = 0.787
**Goal:** Find a model that beats keyword search on our code retrieval benchmark

## Executive Summary

**Top 3 recommendations to test next:**

| Rank | Model | Why | Expected Impact |
|:----:|-------|-----|-----------------|
| 🥇 | `BAAI/bge-m3` | Best all-around, no prompts, 8192 ctx, dense+sparse+colbert, MIT license, 18M+ downloads | Highest ceiling — could leapfrog keyword by 5-10% |
| 🥈 | `Alibaba-NLP/gte-modernbert-base` | **Has CoIR code retrieval benchmarks (79.31 NDCG@10)**, 8192 ctx, 149M params (small!), Apache-2.0 | Best code-specific evidence — small, fast, code-optimized |
| 🥉 | `Alibaba-NLP/gte-large-en-v1.5` | Highest MTEB Retrieval score (57.91) among no-prompt models, 8192 ctx, 1024-dim | Strong general retrieval, larger but more capable |

---

## Detailed Model Analysis

### 🥇 1. BAAI/bge-m3 — Best Overall Pick

| Property | Value |
|----------|-------|
| **Dimensions** | 1024 |
| **Max Sequence Length** | 8192 tokens |
| **Base Model** | xlm-roberta-large |
| **Size** | ~1.2 GB |
| **Needs Prompt** | ❌ NO — explicitly stated in README FAQ |
| **sentence-transformers** | ✅ Yes (library_name on HF) |
| **License** | MIT |
| **Downloads** | 18.4M+ |
| **Likes** | 2,949 |
| **Architecture** | XLMRobertaModel |

**Why it's the top pick:**
- **No instruction prompt needed.** The README FAQ explicitly states: "the BGE-M3 model no longer requires adding instructions to the queries." This is our #1 hard requirement.
- **8192 token context** — 21x longer than all-mpnet-base-v2's 384 tokens. Critical for embedding code files without truncation.
- **Multi-functionality** — supports dense retrieval, sparse (lexical) retrieval, AND multi-vector (ColBERT) retrieval simultaneously. Could replace both vector AND BM25/FTS5 in our pipeline.
- **Self-knowledge distillation** — trained to work well across all three retrieval modes.
- **Massive adoption** — 18M+ downloads, most popular embedding model on HuggingFace.
- **Works with sentence-transformers** out of the box for dense embeddings. Also has a FlagEmbedding library for the hybrid modes.
- **1024 dimensions** — richer representation than all-mpnet-base-v2's 768.

**Potential concerns:**
- 1.2 GB download (larger than current model)
- xlm-roberta-large backbone is slower than mpnet-base
- Multilingual = slightly less English-focused optimization
- No explicit CoIR/CodeSearchNet benchmarks published (but multilingual+long-context training likely helps)

**Usage with our gpu-embedder.py:**
```bash
python3 scripts/gpu-embedder.py --model BAAI/bge-m3 --device cuda --max-seq-length 8192
```
No code changes needed — it's a drop-in replacement.

---

### 🥈 2. Alibaba-NLP/gte-modernbert-base — Best Code-Specific Evidence

| Property | Value |
|----------|-------|
| **Dimensions** | 768 |
| **Max Sequence Length** | 8192 tokens |
| **Base Model** | answerdotai/ModernBERT-base |
| **Size** | ~560 MB (149M params) |
| **Needs Prompt** | ❌ NO — standard usage, no instruction prefix |
| **sentence-transformers** | ✅ Yes (explicit example in README) |
| **License** | Apache-2.0 |
| **MTEB Average** | 64.38 |
| **MTEB Retrieval** | 55.33 |
| **BEIR Average** | 55.33 |
| **LoCo (Long Doc)** | 87.57 |
| **CoIR (Code Retrieval)** | **79.31** |

**Why it's #2:**
- **Explicit CoIR code retrieval benchmarks: 79.31 NDCG@10 across 20 code tasks.** This is the strongest signal we have for code search performance. Includes CodeSearchNet (Go, Java, JavaScript, PHP, Python, Ruby), Apps, CodeFeedback, CosQA, StackOverflow-QA, and more.
- **Smallest model (149M params, ~560 MB)** — faster inference than bge-m3, smaller download.
- **8192 token context** — same as bge-m3.
- **Built on ModernBERT** — a state-of-the-art encoder model from Answer.AI.
- **No instruction prompt needed** — the README shows direct `model.encode(input_texts)` usage with sentence-transformers.
- **768 dimensions** — same as our current model, no dimension migration needed.
- **Apache-2.0 license** — fully permissive.

**CoIR breakdown (highlights):**
- CodeSearchNet-ccr-javascript: **94.27** — directly relevant to our TypeScript codebase
- CodeSearchNet-python: **93.93** — strong Python understanding
- CodeSearchNet-ccr-python: **93.93**
- CosQA (code-search QA): **91.2** — natural language → code retrieval
- stackoverflow-qa: **43.47** — weaker on Q&A format
- synthetic-text2sql: **61.87**

**Potential concerns:**
- Newer model, less battle-tested than bge-m3
- 768-dim may not capture as much nuance as 1024-dim alternatives
- MTEB retrieval score (55.33) is lower than gte-large-en-v1.5 (57.91)

**Usage:**
```bash
python3 scripts/gpu-embedder.py --model Alibaba-NLP/gte-modernbert-base --device cuda --max-seq-length 8192
```

---

### 🥉 3. Alibaba-NLP/gte-large-en-v1.5 — Strong General Retrieval

| Property | Value |
|----------|-------|
| **Dimensions** | 1024 |
| **Max Sequence Length** | 8192 tokens |
| **Base Model** | BERT-large |
| **Size** | ~1.3 GB (409M params) |
| **Needs Prompt** | ❌ NO |
| **sentence-transformers** | ✅ Yes |
| **License** | Apache-2.0 |
| **MTEB Average** | **65.39** (highest among no-prompt models) |
| **MTEB Retrieval** | **57.91** (highest among no-prompt models) |

**Why it's #3:**
- **Highest MTEB retrieval score** among all no-prompt models surveyed (57.91). This is the gold standard benchmark.
- **1024 dimensions** — richer representations.
- **8192 token context**.
- **MTEB average 65.39** — best overall performance of any model in our candidate list that doesn't need prompts.
- **No instruction prefix needed.**
- **Apache-2.0 license.**

**Potential concerns:**
- 1.3 GB download (largest candidate)
- No explicit CoIR code retrieval benchmarks published
- Larger model = slower inference than gte-modernbert-base

**Usage:**
```bash
python3 scripts/gpu-embedder.py --model Alibaba-NLP/gte-large-en-v1.5 --device cuda --max-seq-length 8192
```

---

## Models Considered But Rejected

### Rejected: Requires Instruction Prompts (Won't Work With gpu-embedder.py)

| Model | Dim | Prompt Required | Why Rejected |
|-------|:---:|----------------|--------------|
| `BAAI/bge-large-en-v1.5` | 1024 | `"Represent this sentence for searching relevant passages: "` | Requires prepending instruction to queries; our gpu-embedder.py has no prompt support. Would need code changes + asymmetric embedding logic (prompt on query, no prompt on documents). |
| `BAAI/bge-base-en-v1.5` | 768 | Same as above | Same issue. |
| `intfloat/e5-large-v2` | 1024 | `"query: "` prefix on queries, `"passage: "` on documents | Asymmetric encoding required. gpu-embedder.py treats all texts identically. |
| `intfloat/e5-base-v2` | 768 | Same as above | Same issue. |
| `intfloat/multilingual-e5-large` | 1024 | Same as above | Same issue + 2.1 GB download. |
| `Salesforce/SFR-Embedding-2_R` | 4096 | `"Instruct: {task}\nQuery: {query}"` | Requires per-task instruction. Also **CC-BY-NC-4.0 license** (non-commercial). |
| `BAAI/bge-code-v1` | 1536 | `<instruct>` XML tags | Already tested, scored R@10=0.196 (catastrophically broken without prompts). |

**Note on prompt-requiring models:** We could potentially support these by modifying `gpu-embedder.py` to accept a `--query-prefix` flag and adding logic to prepend prompts to queries but not documents. However, this requires changes to the TypeScript embedding provider too, and is a bigger architectural change. The no-prompt models are a safer starting point.

### Rejected: Not sentence-transformers Compatible

| Model | Why Rejected |
|-------|--------------|
| `microsoft/unixcoder-base` | `pipeline_tag: feature-extraction`, NOT `sentence-similarity`. Would need custom pooling + fine-tuning to produce usable embeddings. Not a drop-in replacement. |
| `Salesforce/CodeSage-large` | Gated model (401 unauthorized). Not publicly accessible. |
| CodeBERT (microsoft/codebert-base) | Masked language model, not a sentence embedding model. Would need extensive custom work. |

### Rejected: Other Issues

| Model | Why Rejected |
|-------|--------------|
| `BAAI/bge-en-icl` | LLM-based (likely slow), requires in-context examples. |
| `BAAI/bge-multilingual-gemma2` | 9B parameter model — way too large for RTX 3080. |
| `Alibaba-NLP/gte-Qwen2-7B-instruct` | 7B parameter LLM-based model — too large, requires instruction prompts. |

---

## Also Worth Considering (Lower Priority)

### `nomic-ai/nomic-embed-text-v1.5`

| Property | Value |
|----------|-------|
| **Dimensions** | 768 (Matryoshka — can use 64, 128, 256, 512, 768) |
| **Max Sequence Length** | 8192 |
| **Size** | ~550 MB |
| **Needs Prompt** | Optional (`"search_query: "` for queries, `"search_document: "` for docs) |
| **sentence-transformers** | ✅ Yes (requires `trust_remote_code=True`) |
| **License** | Custom (free for commercial use under 1M users) |
| **MTEB Average** | 62.28 |

**Why lower priority:** Lower MTEB scores than the top 3. The optional prompt mechanism means it could work without prompts (suboptimal) or with prompts (needs code changes). Matryoshka embeddings are nice for dimensionality reduction but add complexity. Custom license has usage caps.

### `Alibaba-NLP/gte-base-en-v1.5`

| Property | Value |
|----------|-------|
| **Dimensions** | 768 |
| **Max Sequence Length** | 8192 |
| **Size** | ~420 MB (137M params) |
| **MTEB Average** | 64.11 |
| **MTEB Retrieval** | 54.09 |

**Why lower priority:** Very similar to gte-modernbert-base but slightly lower MTEB scores and no explicit CoIR benchmarks. The modernbert version is likely superior for code.

### `mixedbread-ai/mxbai-embed-large-v1`

| Property | Value |
|----------|-------|
| **Dimensions** | 1024 |
| **Max Sequence Length** | 512 |
| **MTEB Average** | 64.68 |

**Why lower priority:** 512 token max length is too short for code files. Would require truncation like our current model. The 8192 context of the top 3 candidates is a major advantage.

---

## Comparative Benchmark Summary

### MTEB Retrieval Score (higher = better at finding relevant documents)

| Model | MTEB Retrieval | CoIR (Code) | Max Seq | Needs Prompt |
|-------|:--------------:|:-----------:|:-------:|:------------:|
| gte-large-en-v1.5 | **57.91** | — | 8192 | No |
| bge-large-en-v1.5 | 54.29 | — | 512 | **Yes** |
| mxbai-embed-large-v1 | 54.39 | — | 512 | No |
| **gte-modernbert-base** | 55.33 | **79.31** | 8192 | No |
| gte-base-en-v1.5 | 54.09 | — | 8192 | No |
| bge-base-en-v1.5 | 53.25 | — | 512 | **Yes** |
| nomic-embed-text-v1.5 | 53.01 | — | 8192 | Optional |
| **BAAI/bge-m3** | — (multilingual) | — | 8192 | No |

### Key Dimensions Comparison

| Feature | all-mpnet-base-v2 (current) | bge-m3 | gte-modernbert-base | gte-large-en-v1.5 |
|---------|:---------------------------:|:------:|:-------------------:|:------------------:|
| Dimensions | 768 | 1024 | 768 | 1024 |
| Max Tokens | 384 | 8192 | 8192 | 8192 |
| Size (MB) | ~420 | ~1200 | ~560 | ~1300 |
| Needs Prompt | No | No | No | No |
| License | Apache-2.0 | MIT | Apache-2.0 | Apache-2.0 |
| Code Benchmarks | No | No | **Yes (CoIR)** | No |
| Drop-in for gpu-embedder.py | ✅ | ✅ | ✅ | ✅ |

---

## Why 8192 Token Context Matters

Our current model (all-mpnet-base-v2) has a 384-token limit. Code files regularly exceed this:

- A 100-line TypeScript file is typically 800-1200 tokens
- The average chunk in our benchmark is likely truncated
- Truncation means the model only "sees" the first ~30 lines of each file
- This throws away implementation details, error handling, and the actual logic

All three top candidates support 8192 tokens — meaning the model can see the **entire file** for most source files. This alone could significantly improve retrieval quality.

---

## Implementation Plan

### Phase 1: Drop-in Testing (No code changes needed)

Each model can be tested with our existing `gpu-embedder.py` by just changing the `--model` argument:

```bash
# Test 1: bge-m3
python3 scripts/gpu-embedder.py --model BAAI/bge-m3 --device cuda --max-seq-length 8192

# Test 2: gte-modernbert-base
python3 scripts/gpu-embedder.py --model Alibaba-NLP/gte-modernbert-base --device cuda --max-seq-length 8192

# Test 3: gte-large-en-v1.5
python3 scripts/gpu-embedder.py --model Alibaba-NLP/gte-large-en-v1.5 --device cuda --max-seq-length 8192
```

Then re-run the benchmark:
```bash
npx tsx benchmarks/evaluate.ts
```

### Phase 2: If bge-m3 wins, explore hybrid retrieval

BGE-M3 supports sparse + dense + ColBERT retrieval simultaneously. This could replace our entire FTS5 + vector + graph pipeline with a single model call. Requires using the `FlagEmbedding` library instead of sentence-transformers.

### Phase 3: Consider prompt-based models

If no-prompt models don't close the gap, consider adding `--query-prefix` support to `gpu-embedder.py` and testing:
- `BAAI/bge-large-en-v1.5` with prefix `"Represent this sentence for searching relevant passages: "`
- `intfloat/e5-large-v2` with prefix `"query: "` and `"passage: "`

---

## Expected Performance Gains

Based on the MTEB retrieval scores and model capabilities:

| Model | Expected R@10 | Reasoning |
|-------|:-------------:|-----------|
| all-mpnet-base-v2 (current) | 0.729 | Baseline |
| gte-modernbert-base | 0.77-0.82 | 8192 ctx + code-specific training (CoIR 79.31) + same dims |
| bge-m3 | 0.78-0.85 | 8192 ctx + 1024-dim + multilingual robustness + massive training |
| gte-large-en-v1.5 | 0.76-0.83 | 8192 ctx + 1024-dim + best MTEB retrieval (57.91) |

The 8192 token context alone should provide a significant boost because our code files are currently truncated at 384 tokens.

---

## Sources

- BAAI/bge-m3 README: https://huggingface.co/BAAI/bge-m3/raw/main/README.md
- FlagEmbedding GitHub: https://github.com/FlagOpen/FlagEmbedding (master README)
- Alibaba-NLP/gte-modernbert-base README: https://huggingface.co/Alibaba-NLP/gte-modernbert-base/raw/main/README.md
- Salesforce/SFR-Embedding-2_R README: https://huggingface.co/Salesforce/SFR-Embedding-2_R/raw/main/README.md
- HuggingFace model APIs for size/architecture data
- Spacefolding benchmarks: benchmarks/ABLATION-GPU.md, benchmarks/ABLATION-REAL-EMBEDDINGS.md
