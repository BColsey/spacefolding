/**
 * Ablation Study — Phase 3 of the evaluation research plan
 *
 * Tests each component of the Spacefolding retrieval pipeline in isolation
 * to determine which parts help and which hurt.
 *
 * Strategies tested:
 *   1. fts-only        — FTS5 BM25 alone (no fusion, no vectors, no graph)
 *   2. vector-only     — Vector search alone (no FTS, no fusion, no graph)
 *   3. fts-vector-rrf  — FTS5 + vector with RRF (no graph)
 *   4. full-pipeline   — Complete: vector + FTS + graph + RRF (current default)
 *   5. fts-top10       — FTS5 alone, cap at 10 results
 *   6. keyword          — Keyword grep baseline (for comparison)
 *
 * Usage:
 *   npx tsx benchmarks/ablation.ts [--local-embeddings]
 */

import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRelativePath, walkBenchmarkSourceFiles } from './source-files.js';
import { createBenchmarkSqliteArtifact } from './temp-artifacts.js';

// ── Types ──

interface BenchmarkTask {
  id: string;
  task: string;
  intent: string;
  relevant_files: string[];
  relevant_types?: string[];
  relevant_keywords?: string[];
  irrelevant_files?: string[];
  difficulty?: string;
  source?: string;
}

export interface AblationDataset {
  tasks: BenchmarkTask[];
}

interface Metrics {
  recallAt5: number;
  recallAt10: number;
  recallAt20: number;
  precisionAt5: number;
  precisionAt10: number;
  precisionAt20: number;
  ndcgAt10: number;
  ndcgAt20: number;
  mrr: number;
  avgResults: number;
}

interface EmbeddingProviderLike {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export interface AblationCliOptions {
  dataset: string;
  localEmbeddings: boolean;
  gpu: boolean;
}

export function parseArgs(
  argv: string[],
  benchDir: string = dirname(fileURLToPath(import.meta.url))
): AblationCliOptions {
  const options: AblationCliOptions = {
    dataset: join(benchDir, 'dataset.json'),
    localEmbeddings: false,
    gpu: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dataset') {
      options.dataset = resolve(benchDir, readOptionValue(argv, i++, arg));
    } else if (arg === '--local-embeddings') {
      options.localEmbeddings = true;
    } else if (arg === '--gpu') {
      options.gpu = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function readOptionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireTaskString(
  task: Record<string, unknown>,
  field: string,
  index: number,
  datasetPath: string
): string {
  const value = task[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Ablation dataset task ${index + 1} field ${field} must be a non-empty string: ${datasetPath}`
    );
  }
  return value;
}

function requireTaskStringArray(
  task: Record<string, unknown>,
  field: string,
  index: number,
  datasetPath: string
): string[] {
  const value = task[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(
      `Ablation dataset task ${index + 1} field ${field} must be an array of strings: ${datasetPath}`
    );
  }
  return value;
}

function optionalTaskStringArray(
  task: Record<string, unknown>,
  field: string,
  index: number,
  datasetPath: string
): string[] | undefined {
  const value = task[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(
      `Ablation dataset task ${index + 1} field ${field} must be an array of strings: ${datasetPath}`
    );
  }
  return value;
}

function optionalTaskString(
  task: Record<string, unknown>,
  field: string,
  index: number,
  datasetPath: string
): string | undefined {
  const value = task[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Ablation dataset task ${index + 1} field ${field} must be a non-empty string: ${datasetPath}`
    );
  }
  return value;
}

export function parseAblationDataset(data: unknown, datasetPath: string): AblationDataset {
  if (!isRecord(data) || !Array.isArray(data.tasks)) {
    throw new Error(`Ablation dataset must contain a tasks array: ${datasetPath}`);
  }
  if (data.tasks.length === 0) {
    throw new Error(`Ablation dataset has no tasks: ${datasetPath}`);
  }

  return {
    tasks: data.tasks.map((task, index) => {
      if (!isRecord(task)) {
        throw new Error(`Ablation dataset task ${index + 1} must be an object: ${datasetPath}`);
      }

      return {
        id: requireTaskString(task, 'id', index, datasetPath),
        task: requireTaskString(task, 'task', index, datasetPath),
        intent: requireTaskString(task, 'intent', index, datasetPath),
        relevant_files: requireTaskStringArray(task, 'relevant_files', index, datasetPath),
        relevant_types: optionalTaskStringArray(task, 'relevant_types', index, datasetPath),
        relevant_keywords: optionalTaskStringArray(task, 'relevant_keywords', index, datasetPath),
        irrelevant_files: optionalTaskStringArray(task, 'irrelevant_files', index, datasetPath),
        difficulty: optionalTaskString(task, 'difficulty', index, datasetPath),
        source: optionalTaskString(task, 'source', index, datasetPath),
      };
    }),
  };
}

export function loadAblationDataset(datasetPath: string): AblationDataset {
  let raw: string;
  try {
    raw = readFileSync(datasetPath, 'utf-8');
  } catch (error) {
    throw new Error(`Unable to read ablation dataset JSON at ${datasetPath}: ${errorMessage(error)}`);
  }

  try {
    return parseAblationDataset(JSON.parse(raw) as unknown, datasetPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Malformed ablation dataset JSON at ${datasetPath}: ${error.message}`);
    }
    throw error;
  }
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRng(seedText: string): () => number {
  let state = hashString(seedText) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

// ── Metrics ──

function computeMetrics(retrieved: string[], relevant: Set<string>, totalRelevant: number): Metrics {
  const recallAt = (k: number) => {
    const topK = retrieved.slice(0, k);
    return totalRelevant > 0 ? topK.filter((p) => relevant.has(p)).length / totalRelevant : 0;
  };
  const precisionAt = (k: number) => {
    if (k === 0) return 0;
    return retrieved.slice(0, k).filter((p) => relevant.has(p)).length / k;
  };
  const ndcgAt = (k: number) => {
    const topK = retrieved.slice(0, k);
    let dcg = 0;
    for (let i = 0; i < topK.length; i++) {
      dcg += (relevant.has(topK[i]) ? 1 : 0) / Math.log2(i + 2);
    }
    let idcg = 0;
    for (let i = 0; i < Math.min(totalRelevant, k); i++) idcg += 1 / Math.log2(i + 2);
    return idcg > 0 ? dcg / idcg : 0;
  };
  const mrr = (() => {
    for (let i = 0; i < retrieved.length; i++) {
      if (relevant.has(retrieved[i])) return 1 / (i + 1);
    }
    return 0;
  })();

  return {
    recallAt5: recallAt(5), recallAt10: recallAt(10), recallAt20: recallAt(20),
    precisionAt5: precisionAt(5), precisionAt10: precisionAt(10), precisionAt20: precisionAt(20),
    ndcgAt10: ndcgAt(10), ndcgAt20: ndcgAt(20), mrr, avgResults: retrieved.length,
  };
}

/** Bootstrap confidence intervals for a metric across tasks */
function bootstrapCI(
  taskResults: { metrics: Metrics }[],
  metricKey: keyof Metrics,
  nBoot = 10_000,
  ci = 0.95
): { mean: number; low: number; high: number; std: number } {
  const n = taskResults.length;
  const values = taskResults.map((r) => r.metrics[metricKey]);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
  const rng = createRng(`bootstrap:${String(metricKey)}:${values.map((v) => v.toFixed(6)).join(',')}`);

  // Bootstrap resampling
  const bootMeans: number[] = [];
  for (let b = 0; b < nBoot; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += values[Math.floor(rng() * n)];
    }
    bootMeans.push(sum / n);
  }
  bootMeans.sort((a, b) => a - b);

  const alpha = (1 - ci) / 2;
  const low = bootMeans[Math.floor(nBoot * alpha)];
  const high = bootMeans[Math.ceil(nBoot * (1 - alpha))];

  return { mean, low, high, std };
}

// ── Walk dir ──

function walkDir(dir: string): string[] {
  return walkBenchmarkSourceFiles(dir, { extensions: ['.ts'] });
}

// ── Main ──

async function runAblation(options: AblationCliOptions) {
  const benchDir = dirname(fileURLToPath(import.meta.url));
  const dataset = loadAblationDataset(options.dataset);

  const strategies = [
    'keyword',      // Baseline: keyword grep
    'fts-only',     // FTS5 BM25 alone
    'fts-top10',    // FTS5 capped at 10 results
    'vector-only',  // Vector search alone
    'fts-vector-rrf', // FTS + vector RRF, no graph
    'full-pipeline', // Everything: vector + FTS + graph + RRF
  ];

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ABLATION STUDY — isolating each retrieval component`);
  console.log(`  Tasks: ${dataset.tasks.length}`);
  console.log(`${'═'.repeat(70)}\n`);

  // Build pipeline
  const { createRepository } = await import('../dist/storage/repository.js');
  const { DeterministicTokenEstimator } = await import('../dist/providers/token-estimator.js');
  const { DeterministicEmbeddingProvider } = await import('../dist/providers/deterministic-embedding.js');
  const { DeterministicCompressionProvider } = await import('../dist/providers/deterministic-compression.js');
  const { SimpleDependencyAnalyzer } = await import('../dist/providers/dependency-analyzer.js');
  const { ContextScorer } = await import('../dist/core/scorer.js');
  const { ContextRouter, DEFAULT_ROUTING_CONFIG } = await import('../dist/core/router.js');
  const { ContextIngester } = await import('../dist/core/ingester.js');
  const { PipelineOrchestrator } = await import('../dist/pipeline/orchestrator.js');

  const useLocalEmbeddings = options.localEmbeddings;
  const useGpu = options.gpu;
  let embeddingProvider: EmbeddingProviderLike;
  if (useGpu) {
    const { GpuEmbeddingProvider } = await import('../dist/providers/gpu-embedding.js');
    const modelId = process.env.GPU_EMBEDDING_MODEL ?? 'all-mpnet-base-v2';
    const device = process.env.GPU_EMBEDDING_DEVICE ?? 'cuda';
    console.log(`Using GPU embeddings: ${modelId} on ${device}`);
    embeddingProvider = new GpuEmbeddingProvider(modelId, device);
  } else if (useLocalEmbeddings) {
    const { LocalEmbeddingProvider } = await import('../dist/providers/local-embedding.js');
    const modelId = process.env.EMBEDDING_MODEL ?? 'Xenova/bge-small-en-v1.5';
    console.log(`Using LOCAL embeddings: ${modelId}`);
    embeddingProvider = new LocalEmbeddingProvider(modelId);
  } else {
    console.log('Using DETERMINISTIC embeddings (hash-based, near-random)');
    embeddingProvider = new DeterministicEmbeddingProvider();
  }

  const dbArtifact = createBenchmarkSqliteArtifact('ablation-eval');
  const dbPath = dbArtifact.path;

  const storage = createRepository(dbPath);
  const tokenEstimator = new DeterministicTokenEstimator();
  const pipeline = new PipelineOrchestrator(
    storage,
    new ContextScorer(DEFAULT_ROUTING_CONFIG, embeddingProvider, tokenEstimator),
    new ContextRouter(DEFAULT_ROUTING_CONFIG),
    new DeterministicCompressionProvider(),
    new SimpleDependencyAnalyzer(),
    new ContextIngester(tokenEstimator),
    embeddingProvider
  );

  // Ingest source
  const srcDir = join(benchDir, '..', 'src');
  const files = walkDir(srcDir);
  console.log(`Ingesting ${files.length} files...\n`);
  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const relativePath = projectRelativePath(join(benchDir, '..'), filePath);
    await pipeline.ingest('file', content, undefined, relativePath, undefined);
  }
  const allChunks = storage.getAllChunks();
  console.log(`Ingested ${allChunks.length} chunks\n`);

  // ── Strategy implementations ──

  async function keywordSearch(task: BenchmarkTask): Promise<string[]> {
    const queryWords = task.task.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3);
    const stopWords = new Set(['that', 'this', 'with', 'from', 'does', 'have', 'been', 'were', 'will', 'would', 'could', 'should', 'than', 'then', 'into', 'when', 'where', 'which', 'their']);
    const terms = queryWords.filter((w) => !stopWords.has(w));
    const scored = allChunks.map((chunk) => {
      const content = (chunk.text + ' ' + (chunk.path ?? '')).toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (content.includes(term)) score += 2;
        if (chunk.path?.toLowerCase().includes(term)) score += 3;
      }
      return { path: chunk.path ?? chunk.id, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.filter((s) => s.score > 0).map((s) => s.path);
  }

  async function ftsOnly(task: BenchmarkTask): Promise<string[]> {
    const results = storage.searchByText(task.task, 50);
    return results.map((r) => {
      const chunk = storage.getChunk(r.chunkId);
      return chunk?.path ?? r.chunkId;
    });
  }

  async function ftsTop10(task: BenchmarkTask): Promise<string[]> {
    const results = storage.searchByText(task.task, 10);
    return results.map((r) => {
      const chunk = storage.getChunk(r.chunkId);
      return chunk?.path ?? r.chunkId;
    });
  }

  async function vectorOnly(task: BenchmarkTask): Promise<string[]> {
    const queryEmbedding = await embeddingProvider.embed(task.task);
    const results = storage.searchByVector(queryEmbedding, 50);
    return results.map((r) => {
      const chunk = storage.getChunk(r.chunkId);
      return chunk?.path ?? r.chunkId;
    });
  }

  async function ftsVectorRRF(task: BenchmarkTask): Promise<string[]> {
    const queryEmbedding = await embeddingProvider.embed(task.task);
    const vecResults = storage.searchByVector(queryEmbedding, 50);
    const ftsResults = storage.searchByText(task.task, 50);

    // RRF fusion
    const scores = new Map<string, { fused: number }>();
    for (let i = 0; i < ftsResults.length; i++) {
      const id = ftsResults[i].chunkId;
      scores.set(id, { fused: (scores.get(id)?.fused ?? 0) + 1 / (60 + i + 1) });
    }
    for (let i = 0; i < vecResults.length; i++) {
      const id = vecResults[i].chunkId;
      scores.set(id, { fused: (scores.get(id)?.fused ?? 0) + 1 / (60 + i + 1) });
    }

    return [...scores.entries()]
      .sort((a, b) => b[1].fused - a[1].fused)
      .slice(0, 50)
      .map(([id]) => {
        const chunk = storage.getChunk(id);
        return chunk?.path ?? id;
      });
  }

  async function fullPipeline(task: BenchmarkTask): Promise<string[]> {
    const result = await pipeline.retrieve(task.task, 200_000, {
      strategy: 'hybrid', topK: 50, maxHops: 2,
    });
    return result.chunks.map((c: any) => c.path).filter(Boolean);
  }

  const strategyFn: Record<string, (task: BenchmarkTask) => Promise<string[]>> = {
    'keyword': keywordSearch,
    'fts-only': ftsOnly,
    'fts-top10': ftsTop10,
    'vector-only': vectorOnly,
    'fts-vector-rrf': ftsVectorRRF,
    'full-pipeline': fullPipeline,
  };

  // ── Run ──

  const allResults: Record<string, { task: BenchmarkTask; metrics: Metrics; hits: string[]; misses: string[] }[]> = {};

  for (const strat of strategies) {
    allResults[strat] = [];

    console.log(`\n${'─'.repeat(70)}`);
    console.log(`  ${strat.toUpperCase()}`);
    console.log(`${'─'.repeat(70)}\n`);

    for (const task of dataset.tasks) {
      const relevantSet = new Set(task.relevant_files);
      const retrieved = [...new Set(await strategyFn[strat](task))];
      const metrics = computeMetrics(retrieved, relevantSet, task.relevant_files.length);
      const hits = retrieved.filter((p) => relevantSet.has(p));
      const misses = task.relevant_files.filter((f) => !retrieved.includes(f));

      allResults[strat].push({ task, metrics, hits, misses });

      const icon = hits.length > 0 ? '✓' : '✗';
      console.log(
        `  ${icon} ${task.id} [${task.intent.padEnd(12)}] ` +
        `R@10=${metrics.recallAt10.toFixed(2)} P@10=${metrics.precisionAt10.toFixed(2)} ` +
        `NDCG=${metrics.ndcgAt10.toFixed(2)} MRR=${metrics.mrr.toFixed(2)} ` +
        `hits=${hits.length}/${task.relevant_files.length} ` +
        `miss=${misses.join(',') || 'none'} ` +
        `results=${metrics.avgResults}`
      );
    }

    // Averages
    const avg: Record<string, number> = {};
    for (const key of Object.keys(allResults[strat][0].metrics) as (keyof Metrics)[]) {
      avg[key] = allResults[strat].reduce((s, r) => s + r.metrics[key], 0) / allResults[strat].length;
    }
    console.log(`\n  ${'─'.repeat(50)}`);
    console.log(`  AVERAGE (${dataset.tasks.length} tasks)`);
    console.log(`  ${'─'.repeat(50)}`);
    console.log(`  Recall@5:    ${avg.recallAt5.toFixed(3)}`);
    console.log(`  Recall@10:   ${avg.recallAt10.toFixed(3)}`);
    console.log(`  Recall@20:   ${avg.recallAt20.toFixed(3)}`);
    console.log(`  Precis@5:    ${avg.precisionAt5.toFixed(3)}`);
    console.log(`  Precis@10:   ${avg.precisionAt10.toFixed(3)}`);
    console.log(`  NDCG@10:     ${avg.ndcgAt10.toFixed(3)}`);
    console.log(`  MRR:         ${avg.mrr.toFixed(3)}`);
    console.log(`  Avg results: ${avg.avgResults.toFixed(1)}`);
  }

  // ── Comparison Table ──

  console.log(`\n\n${'═'.repeat(70)}`);
  console.log(`  COMPARISON TABLE`);
  console.log(`${'═'.repeat(70)}\n`);

  const header = 'Metric                    ' + strategies.map((s) => s.padEnd(16)).join('');
  console.log(`  ${header}`);
  console.log(`  ${'─'.repeat(header.length)}`);

  const metricLabels: [keyof Metrics, string][] = [
    ['recallAt5', 'Recall@5  '],
    ['recallAt10', 'Recall@10 '],
    ['recallAt20', 'Recall@20 '],
    ['precisionAt5', 'Precis@5  '],
    ['precisionAt10', 'Precis@10 '],
    ['ndcgAt10', 'NDCG@10   '],
    ['mrr', 'MRR       '],
    ['avgResults', 'Avg results'],
  ];

  for (const [key, label] of metricLabels) {
    const row = strategies.map((strat) => {
      const avg = allResults[strat].reduce((s, r) => s + r.metrics[key], 0) / allResults[strat].length;
      return avg.toFixed(3).padEnd(16);
    });
    console.log(`  ${label}             ${row.join('')}`);
  }

  // ── By intent ──

  console.log(`\n  Recall@10 by intent:\n`);
  const intents = [...new Set(dataset.tasks.map((t) => t.intent))];
  const intentHeader = 'Intent          ' + strategies.map((s) => s.padEnd(16)).join('');
  console.log(`  ${intentHeader}`);
  console.log(`  ${'─'.repeat(intentHeader.length)}`);
  for (const intent of intents) {
    const row = strategies.map((strat) => {
      const intentResults = allResults[strat].filter((r) => r.task.intent === intent);
      const avg = intentResults.reduce((s, r) => s + r.metrics.recallAt10, 0) / intentResults.length;
      return avg.toFixed(3).padEnd(16);
    });
    console.log(`  ${intent.padEnd(16)}${row.join('')}`);
  }

  // ── By difficulty ──

  const difficulties = [...new Set(dataset.tasks.map((t) => t.difficulty).filter(Boolean))] as string[];
  if (difficulties.length > 0) {
    console.log(`\n  Recall@10 by difficulty:\n`);
    const diffHeader = 'Difficulty       ' + strategies.map((s) => s.padEnd(16)).join('');
    console.log(`  ${diffHeader}`);
    console.log(`  ${'─'.repeat(diffHeader.length)}`);
    for (const diff of difficulties) {
      const row = strategies.map((strat) => {
        const diffResults = allResults[strat].filter((r) => r.task.difficulty === diff);
        if (diffResults.length === 0) return 'N/A             ';
        const avg = diffResults.reduce((s, r) => s + r.metrics.recallAt10, 0) / diffResults.length;
        return avg.toFixed(3).padEnd(16);
      });
      console.log(`  ${(diff as string).padEnd(16)}${row.join('')}`);
    }
  }

  // ── By source (expert vs generated) ──

  const sources = [...new Set(dataset.tasks.map((t) => t.source).filter(Boolean))] as string[];
  if (sources.length > 1) {
    console.log(`\n  Recall@10 by source:\n`);
    const srcHeader = 'Source           ' + strategies.map((s) => s.padEnd(16)).join('');
    console.log(`  ${srcHeader}`);
    console.log(`  ${'─'.repeat(srcHeader.length)}`);
    for (const src of sources) {
      const row = strategies.map((strat) => {
        const srcResults = allResults[strat].filter((r) => r.task.source === src);
        if (srcResults.length === 0) return 'N/A             ';
        const avg = srcResults.reduce((s, r) => s + r.metrics.recallAt10, 0) / srcResults.length;
        return avg.toFixed(3).padEnd(16);
      });
      console.log(`  ${(src as string).padEnd(16)}${row.join('')}`);
    }
  }

  // ── Statistical Significance (Bootstrap 95% CI) ──

  console.log(`\n\n${'═'.repeat(70)}`);
  console.log(`  STATISTICAL SIGNIFICANCE — Bootstrap 95% CI (10,000 resamples)`);
  console.log(`${'═'.repeat(70)}\n`);

  const sigMetrics: (keyof Metrics)[] = ['recallAt10', 'ndcgAt10', 'mrr'];
  const sigLabels: Record<string, string> = { recallAt10: 'R@10', ndcgAt10: 'NDCG@10', mrr: 'MRR' };

  for (const metricKey of sigMetrics) {
    console.log(`  ${sigLabels[metricKey]}:`);
    for (const strat of strategies) {
      const ci = bootstrapCI(allResults[strat], metricKey);
      const ciStr = `[${ci.low.toFixed(3)}, ${ci.high.toFixed(3)}]`;
      console.log(`    ${strat.padEnd(18)} ${ci.mean.toFixed(3)} ${ciStr} (σ=${ci.std.toFixed(3)})`);
    }
    console.log();
  }

  // Pairwise significance test (vector-only vs others)
  console.log(`  Pairwise: vector-only vs others (significant if CI of difference excludes 0):\n`);
  for (const metricKey of sigMetrics) {
    console.log(`    ${sigLabels[metricKey]}:`);
    const baselineValues = allResults['vector-only'].map((r) => r.metrics[metricKey]);
    for (const strat of strategies.filter((s) => s !== 'vector-only')) {
      const otherValues = allResults[strat].map((r) => r.metrics[metricKey]);
      const diffs = baselineValues.map((v, i) => v - otherValues[i]);
      const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      // Bootstrap CI of difference
      const bootDiffs: number[] = [];
      const rng = createRng(`pairwise:${String(metricKey)}:${strat}:${diffs.map((v) => v.toFixed(6)).join(',')}`);
      for (let b = 0; b < 10_000; b++) {
        let sum = 0;
        for (let i = 0; i < diffs.length; i++) {
          sum += diffs[Math.floor(rng() * diffs.length)];
        }
        bootDiffs.push(sum / diffs.length);
      }
      bootDiffs.sort((a, b) => a - b);
      const low = bootDiffs[250];
      const high = bootDiffs[9750];
      const significant = (low > 0 || high < 0) ? '✓ SIGNIFICANT' : '✗ not significant';
      const direction = meanDiff > 0 ? 'wins' : 'loses';
      console.log(`      vs ${strat.padEnd(18)} Δ=${meanDiff >= 0 ? '+' : ''}${meanDiff.toFixed(3)} [${low.toFixed(3)}, ${high.toFixed(3)}] ${significant} (vector ${direction})`);
    }
    console.log();
  }

  // Cleanup
  pipeline.close();
  if ('close' in embeddingProvider && typeof (embeddingProvider as any).close === 'function') {
    (embeddingProvider as any).close();
  }
  dbArtifact.cleanup();

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ABLATION COMPLETE`);
  console.log(`${'═'.repeat(70)}\n`);
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    runAblation(options).catch((err) => {
      console.error(`Ablation failed: ${errorMessage(err)}`);
      process.exit(1);
    });
  } catch (error) {
    console.error(`Ablation failed: ${errorMessage(error)}`);
    process.exit(1);
  }
}
