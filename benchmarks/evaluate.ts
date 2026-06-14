/**
 * Benchmark Evaluation Framework for Spacefolding
 *
 * Measures retrieval accuracy (recall, precision, NDCG) against ground truth
 * and compares multiple retrieval strategies.
 *
 * Usage:
 *   npx tsx benchmarks/evaluate.ts
 *   npx tsx benchmarks/evaluate.ts --strategy vector
 */

import { readFileSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { RetrievalStrategy } from '../src/types/index.js';
import { projectRelativePath, walkBenchmarkSourceFiles } from './source-files.js';
import { createBenchmarkSqliteArtifact } from './temp-artifacts.js';

// ── Types ────────────────────────────────────────────────────

interface BenchmarkTask {
  id: string;
  task: string;
  intent: string;
  relevant_files: string[];
  relevant_types: string[];
  relevant_keywords: string[];
  irrelevant_files: string[];
}

interface BenchmarkDataset {
  tasks: BenchmarkTask[];
}

export interface Metrics {
  recallAt5: number;
  recallAt10: number;
  recallAt20: number;
  precisionAt5: number;
  precisionAt10: number;
  precisionAt20: number;
  ndcgAt10: number;
  ndcgAt20: number;
  mrr: number; // Mean Reciprocal Rank
  hitsAt1: number; // 1.0 if any relevant file is ranked #1, else 0.0
  hitsAt5: number; // 1.0 if any relevant file is in the top 5, else 0.0
  avgResults: number;
}

interface HitDetail {
  path: string;
  rank: number;
}

export interface EvalResult {
  taskId: string;
  task: string;
  intent: string;
  metrics: Metrics;
  details: {
    retrievedPaths: string[];
    relevantPaths: string[];
    hits: string[];
    misses: string[];
    hitDetails: HitDetail[];
    retrievedPathCount: number;
  };
}

export interface StrategySummary {
  strategy: string;
  averages: Record<string, number>;
  results: EvalResult[];
}

export interface EvaluationReport {
  dataset: string;
  corpus: string;
  requestedStrategies: string[];
  strategies: StrategySummary[];
  successGate: {
    requiredStrategySummaries: string[];
    missingStrategySummaries: string[];
    structuralBeatsKeyword?: boolean;
    recallAt10Delta: number | null;
    ndcgAt10Delta: number | null;
    mrrDelta: number | null;
  };
}

export interface CliOptions {
  dataset: string;
  corpus: string;
  strategy: string;
  json: boolean;
  includeTests: boolean;
  workers: number;
  maxChunks: number | null;
}

const ALL_STRATEGIES = ['keyword', 'bm25', 'path-match', 'fts', 'vector', 'symbol-only', 'structural'];
const KNOWN_STRATEGIES = new Set([
  ...ALL_STRATEGIES,
  'hybrid',
  'random',
  'spacefolding',
  'text',
]);
const SUCCESS_GATE_STRATEGIES = ['keyword', 'structural'];

type BenchmarkChunk = { id: string; text: string; path?: string };

interface BenchmarkSymbolRow {
  chunkId?: string;
  path?: string;
  name: string;
  normalizedName: string;
}

interface BenchmarkRuntime {
  storage: any;
  pipeline: any;
  parseStructuralQuery: (query: string) => {
    normalizedIdentifiers: string[];
    identifierParts: string[];
  };
  allSymbols?: BenchmarkSymbolRow[];
  close: () => void;
}

interface IndexedBenchmarkTask {
  index: number;
  task: BenchmarkTask;
}

interface BenchmarkWorkerPayload {
  workerId: number;
  dbPath: string;
  strategy: string;
  tasks: IndexedBenchmarkTask[];
}

type BenchmarkWorkerMessage =
  | { type: 'result'; workerId: number; index: number; result: EvalResult }
  | { type: 'done'; workerId: number }
  | { type: 'error'; workerId: number; message: string };

// ── Scoring Functions ────────────────────────────────────────

function computeMetrics(retrieved: string[], relevant: Set<string>, totalRelevant: number): Metrics {
  const recallAt = (k: number) => {
    const topK = retrieved.slice(0, k);
    const hits = topK.filter((p) => relevant.has(p)).length;
    return totalRelevant > 0 ? hits / totalRelevant : 0;
  };

  const precisionAt = (k: number) => {
    if (k === 0) return 0;
    const topK = retrieved.slice(0, k);
    return topK.filter((p) => relevant.has(p)).length / k;
  };

  const ndcgAt = (k: number) => {
    const topK = retrieved.slice(0, k);
    let dcg = 0;
    for (let i = 0; i < topK.length; i++) {
      const rel = relevant.has(topK[i]) ? 1 : 0;
      dcg += rel / Math.log2(i + 2); // i+2 because log2(1) = 0
    }
    let idcg = 0;
    const idealCount = Math.min(totalRelevant, k);
    for (let i = 0; i < idealCount; i++) {
      idcg += 1 / Math.log2(i + 2);
    }
    return idcg > 0 ? dcg / idcg : 0;
  };

  const mrr = (() => {
    for (let i = 0; i < retrieved.length; i++) {
      if (relevant.has(retrieved[i])) return 1 / (i + 1);
    }
    return 0;
  })();

  // hits@k: 1.0 if any relevant file appears in the top-k results, else 0.0.
  // These are the most meaningful metrics when a task has a single gold file.
  const hitsAt = (k: number) => (retrieved.slice(0, k).some((p) => relevant.has(p)) ? 1 : 0);

  return {
    recallAt5: recallAt(5),
    recallAt10: recallAt(10),
    recallAt20: recallAt(20),
    precisionAt5: precisionAt(5),
    precisionAt10: precisionAt(10),
    precisionAt20: precisionAt(20),
    ndcgAt10: ndcgAt(10),
    ndcgAt20: ndcgAt(20),
    mrr,
    hitsAt1: hitsAt(1),
    hitsAt5: hitsAt(5),
    avgResults: retrieved.length,
  };
}

function readOptionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flag} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireStringField(
  task: Record<string, unknown>,
  field: string,
  index: number,
  datasetPath: string
): string {
  const value = task[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Benchmark dataset task ${index + 1} field ${field} must be a non-empty string: ${datasetPath}`
    );
  }
  return value;
}

function requireStringArrayField(
  task: Record<string, unknown>,
  field: string,
  index: number,
  datasetPath: string
): string[] {
  const value = task[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(
      `Benchmark dataset task ${index + 1} field ${field} must be an array of strings: ${datasetPath}`
    );
  }
  return value;
}

function optionalStringArrayField(
  task: Record<string, unknown>,
  field: string,
  index: number,
  datasetPath: string
): string[] {
  if (task[field] === undefined) return [];
  return requireStringArrayField(task, field, index, datasetPath);
}

export function parseBenchmarkDataset(data: unknown, datasetPath: string): BenchmarkDataset {
  if (!isRecord(data) || !Array.isArray(data.tasks)) {
    throw new Error(`Benchmark dataset must contain a tasks array: ${datasetPath}`);
  }
  if (data.tasks.length === 0) {
    throw new Error(`Benchmark dataset has no tasks: ${datasetPath}`);
  }

  return {
    tasks: data.tasks.map((task, index) => {
      if (!isRecord(task)) {
        throw new Error(`Benchmark dataset task ${index + 1} must be an object: ${datasetPath}`);
      }
      return {
        id: requireStringField(task, 'id', index, datasetPath),
        task: requireStringField(task, 'task', index, datasetPath),
        intent: requireStringField(task, 'intent', index, datasetPath),
        relevant_files: requireStringArrayField(task, 'relevant_files', index, datasetPath),
        relevant_types: optionalStringArrayField(task, 'relevant_types', index, datasetPath),
        relevant_keywords: optionalStringArrayField(task, 'relevant_keywords', index, datasetPath),
        irrelevant_files: optionalStringArrayField(task, 'irrelevant_files', index, datasetPath),
      };
    }),
  };
}

export function loadBenchmarkDataset(datasetPath: string): BenchmarkDataset {
  let raw: string;
  try {
    raw = readFileSync(datasetPath, 'utf-8');
  } catch (error) {
    throw new Error(`Unable to read benchmark dataset JSON at ${datasetPath}: ${errorMessage(error)}`);
  }

  try {
    return parseBenchmarkDataset(JSON.parse(raw) as unknown, datasetPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Malformed benchmark dataset JSON at ${datasetPath}: ${error.message}`);
    }
    throw error;
  }
}

export function parseArgs(argv: string[], benchDir: string): CliOptions {
  const options: CliOptions = {
    dataset: join(benchDir, 'dataset.json'),
    corpus: join(benchDir, '..'),
    strategy: 'all',
    json: false,
    includeTests: false,
    workers: 1,
    maxChunks: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dataset') options.dataset = readOptionValue(argv, i++, arg);
    else if (arg === '--corpus') options.corpus = readOptionValue(argv, i++, arg);
    else if (arg === '--strategy') options.strategy = readOptionValue(argv, i++, arg);
    else if (arg === '--json') options.json = true;
    else if (arg === '--include-tests') options.includeTests = true;
    else if (arg === '--workers') options.workers = parsePositiveInteger(readOptionValue(argv, i++, arg), arg);
    else if (arg === '--max-chunks') options.maxChunks = parsePositiveInteger(readOptionValue(argv, i++, arg), arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function resolveStrategies(strategy: string): string[] {
  if (strategy === 'all') return [...ALL_STRATEGIES];
  if (!KNOWN_STRATEGIES.has(strategy)) {
    throw new Error(`Unknown benchmark strategy "${strategy}". Expected one of: all, ${[...KNOWN_STRATEGIES].sort().join(', ')}`);
  }
  return [strategy];
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededScore(seed: string): number {
  return hashString(seed) / 0xffffffff;
}

// ── Baseline Strategies ──────────────────────────────────────

/** Simple keyword search baseline — grep for task terms across all file paths and content */
async function keywordBaseline(
  task: BenchmarkTask,
  allChunks: { id: string; text: string; path?: string }[]
): Promise<string[]> {
  const queryWords = task.task
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);

  const stopWords = new Set(['that', 'this', 'with', 'from', 'does', 'have', 'been', 'were', 'will', 'would', 'could', 'should', 'than', 'then', 'into', 'when', 'where', 'which', 'their']);
  const terms = queryWords.filter((w) => !stopWords.has(w));

  const scored = allChunks.map((chunk) => {
    const content = (chunk.text + ' ' + (chunk.path ?? '')).toLowerCase();
    let score = 0;
    for (const term of terms) {
      const idx = content.indexOf(term);
      if (idx >= 0) score += 2;
      // Boost if term appears in file path
      if (chunk.path?.toLowerCase().includes(term)) score += 3;
    }
    return { path: chunk.path ?? chunk.id, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).map((s) => s.path);
}

/**
 * Tokenize text for BM25 — lowercase, split on non-word characters, keep
 * tokens of length >= 2 (matches the granularity of a real lexical search).
 */
function bm25Tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

/**
 * Classic Okapi BM25 baseline (k1=1.5, b=0.75).
 *
 * Each chunk is treated as a document — consistent with how the keyword
 * baseline scores `allChunks`. IDF is computed over the chunk corpus, the
 * query is tokenized the same way, and per-chunk BM25 scores are aggregated
 * by file path so the strategy ranks files (like every other strategy here).
 */
async function bm25Baseline(
  task: BenchmarkTask,
  allChunks: { id: string; text: string; path?: string }[]
): Promise<string[]> {
  const K1 = 1.5;
  const B = 0.75;

  // Pre-tokenize documents (one per chunk) and term frequencies.
  const docs = allChunks.map((chunk) => {
    const tokens = bm25Tokenize(chunk.text + ' ' + (chunk.path ?? ''));
    const termFreq = new Map<string, number>();
    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
    }
    return { path: chunk.path ?? chunk.id, length: tokens.length, termFreq };
  });

  const docCount = docs.length;
  if (docCount === 0) return [];

  const avgDocLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docCount;

  // Document frequency per term across the corpus.
  const docFreq = new Map<string, number>();
  for (const doc of docs) {
    for (const term of doc.termFreq.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }

  const queryTerms = [...new Set(bm25Tokenize(task.task))];
  const idf = new Map<string, number>();
  for (const term of queryTerms) {
    const df = docFreq.get(term) ?? 0;
    // Standard BM25 IDF with +1 to keep it non-negative.
    idf.set(term, Math.log(1 + (docCount - df + 0.5) / (df + 0.5)));
  }

  // Aggregate BM25 scores per file path.
  const fileScores = new Map<string, number>();
  for (const doc of docs) {
    let score = 0;
    for (const term of queryTerms) {
      const tf = doc.termFreq.get(term);
      if (!tf) continue;
      const termIdf = idf.get(term) ?? 0;
      const numerator = tf * (K1 + 1);
      const denominator = tf + K1 * (1 - B + (B * doc.length) / avgDocLength);
      score += termIdf * (numerator / denominator);
    }
    if (score <= 0) continue;
    fileScores.set(doc.path, (fileScores.get(doc.path) ?? 0) + score);
  }

  return [...fileScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([path]) => path);
}

/** Random baseline — pick random chunks */
async function randomBaseline(
  task: BenchmarkTask,
  allChunks: { id: string; text: string; path?: string }[]
): Promise<string[]> {
  const shuffled = [...allChunks].sort((a, b) =>
    seededScore(`${task.id}:${a.path ?? a.id}`) - seededScore(`${task.id}:${b.path ?? b.id}`)
  );
  return shuffled.slice(0, 20).map((c) => c.path ?? c.id);
}

/** Path-matching baseline — match task terms against file paths only */
async function pathMatchBaseline(
  task: BenchmarkTask,
  allChunks: { id: string; text: string; path?: string }[]
): Promise<string[]> {
  const queryWords = task.task.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const paths = [...new Set(allChunks.map((c) => c.path).filter(Boolean))] as string[];

  const scored = paths.map((path) => {
    const lower = path.toLowerCase();
    let score = 0;
    for (const word of queryWords) {
      if (lower.includes(word)) score += 1;
    }
    return { path, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).map((s) => s.path);
}

// ── Spacefolding Retrieval ───────────────────────────────────

async function spacefoldingRetrieval(
  task: BenchmarkTask,
  pipeline: any,
  strategy: Exclude<RetrievalStrategy, 'graph'> = 'structural'
): Promise<string[]> {
  const result = await pipeline.retrieve(task.task, 200_000, {
    strategy,
    mode: 'exhaustive',
    topK: 50,
    returnLimit: 50,
    maxHops: 0,
  });

  return result.chunks.map((c: any) => c.path).filter(Boolean);
}

async function symbolOnlyRetrieval(
  task: BenchmarkTask,
  rows: BenchmarkSymbolRow[],
  parseStructuralQuery: (query: string) => {
    normalizedIdentifiers: string[];
    identifierParts: string[];
  }
): Promise<string[]> {
  const query = parseStructuralQuery(task.task);
  const identifiers = new Set(query.normalizedIdentifiers);
  const parts = new Set(query.identifierParts);
  const scored = new Map<string, { path: string; score: number }>();
  for (const symbol of rows) {
    if (!symbol.path) continue;
    let score = 0;
    if (identifiers.has(symbol.normalizedName)) score += 3;
    for (const part of splitBenchmarkIdentifier(symbol.name)) {
      if (parts.has(part)) score += 0.5;
    }
    if (score <= 0) continue;
    const existing = scored.get(symbol.path) ?? { path: symbol.path, score: 0 };
    existing.score += score;
    scored.set(symbol.path, existing);
  }
  return [...scored.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.path);
}

function splitBenchmarkIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_$./:-]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 1);
}

function computeAverageMetrics(results: EvalResult[]): Record<string, number> {
  if (results.length === 0) {
    throw new Error('Cannot compute benchmark averages for an empty result set');
  }

  const avgMetrics: Record<string, number> = {};
  const metricKeys = Object.keys(results[0].metrics) as (keyof Metrics)[];
  for (const key of metricKeys) {
    const sum = results.reduce((s, r) => s + r.metrics[key], 0);
    avgMetrics[key] = sum / results.length;
  }
  return avgMetrics;
}

export function buildEvaluationReport(input: {
  dataset: string;
  corpus: string;
  requestedStrategies: string[];
  strategies: StrategySummary[];
}): EvaluationReport {
  const byStrategy = Object.fromEntries(
    input.strategies.map((summary) => [summary.strategy, summary])
  ) as Record<string, StrategySummary | undefined>;
  const keyword = byStrategy.keyword;
  const structural = byStrategy.structural;
  const missingStrategySummaries = SUCCESS_GATE_STRATEGIES.filter((strategy) => !byStrategy[strategy]);
  const recallAt10Delta = structural && keyword
    ? structural.averages.recallAt10 - keyword.averages.recallAt10
    : null;
  const ndcgAt10Delta = structural && keyword
    ? structural.averages.ndcgAt10 - keyword.averages.ndcgAt10
    : null;
  const mrrDelta = structural && keyword
    ? structural.averages.mrr - keyword.averages.mrr
    : null;

  const successGate: EvaluationReport['successGate'] = {
    requiredStrategySummaries: [...SUCCESS_GATE_STRATEGIES],
    missingStrategySummaries,
    recallAt10Delta,
    ndcgAt10Delta,
    mrrDelta,
  };

  if (keyword && structural) {
    successGate.structuralBeatsKeyword = Boolean(
      recallAt10Delta !== null && recallAt10Delta > 0
      && ndcgAt10Delta !== null && ndcgAt10Delta > 0
      && mrrDelta !== null && mrrDelta > 0
    );
  }

  return {
    dataset: input.dataset,
    corpus: input.corpus,
    requestedStrategies: input.requestedStrategies,
    strategies: input.strategies,
    successGate,
  };
}

async function createEvaluationRuntime(dbPath: string): Promise<BenchmarkRuntime> {
  const { createRepository } = await import('../dist/storage/repository.js');
  const { DeterministicTokenEstimator } = await import('../dist/providers/token-estimator.js');
  const { DeterministicEmbeddingProvider } = await import('../dist/providers/deterministic-embedding.js');
  const { DeterministicCompressionProvider } = await import('../dist/providers/deterministic-compression.js');
  const { SimpleDependencyAnalyzer } = await import('../dist/providers/dependency-analyzer.js');
  const { ContextScorer } = await import('../dist/core/scorer.js');
  const { ContextRouter, DEFAULT_ROUTING_CONFIG } = await import('../dist/core/router.js');
  const { ContextIngester } = await import('../dist/core/ingester.js');
  const { PipelineOrchestrator } = await import('../dist/pipeline/orchestrator.js');
  const { parseStructuralQuery } = await import('../dist/core/query-planner.js');

  const storage = createRepository(dbPath);
  const tokenEstimator = new DeterministicTokenEstimator();
  const embeddingProvider = new DeterministicEmbeddingProvider();
  const compressionProvider = new DeterministicCompressionProvider();
  const dependencyAnalyzer = new SimpleDependencyAnalyzer();
  const scorer = new ContextScorer(DEFAULT_ROUTING_CONFIG, embeddingProvider, tokenEstimator);
  const router = new ContextRouter(DEFAULT_ROUTING_CONFIG);
  const ingester = new ContextIngester(tokenEstimator);
  const pipeline = new PipelineOrchestrator(
    storage, scorer, router, compressionProvider, dependencyAnalyzer, ingester, embeddingProvider
  );

  return {
    storage,
    pipeline,
    parseStructuralQuery,
    close: () => pipeline.close(),
  };
}

async function evaluateBenchmarkTask(
  task: BenchmarkTask,
  strategy: string,
  runtime: BenchmarkRuntime,
  allChunks: BenchmarkChunk[]
): Promise<EvalResult> {
  const relevantSet = new Set(task.relevant_files);
  let retrievedPaths: string[];

  switch (strategy) {
    case 'spacefolding':
    case 'structural':
      retrievedPaths = await spacefoldingRetrieval(task, runtime.pipeline, 'structural');
      break;
    case 'hybrid':
      retrievedPaths = await spacefoldingRetrieval(task, runtime.pipeline, 'hybrid');
      break;
    case 'fts':
    case 'text':
      retrievedPaths = await spacefoldingRetrieval(task, runtime.pipeline, 'text');
      break;
    case 'vector':
      retrievedPaths = await spacefoldingRetrieval(task, runtime.pipeline, 'vector');
      break;
    case 'symbol-only':
      runtime.allSymbols ??= runtime.storage.getAllCodeSymbols() as BenchmarkSymbolRow[];
      retrievedPaths = await symbolOnlyRetrieval(task, runtime.allSymbols, runtime.parseStructuralQuery);
      break;
    case 'keyword':
      retrievedPaths = await keywordBaseline(task, allChunks);
      break;
    case 'bm25':
      retrievedPaths = await bm25Baseline(task, allChunks);
      break;
    case 'path-match':
      retrievedPaths = await pathMatchBaseline(task, allChunks);
      break;
    case 'random':
      retrievedPaths = await randomBaseline(task, allChunks);
      break;
    default:
      retrievedPaths = [];
  }

  const uniquePaths = [...new Set(retrievedPaths)];
  const metrics = computeMetrics(uniquePaths, relevantSet, task.relevant_files.length);
  const hits = uniquePaths.filter((p) => relevantSet.has(p));
  const misses = task.relevant_files.filter((f) => !uniquePaths.includes(f));
  const hitDetails = hits.map((path) => ({
    path,
    rank: uniquePaths.indexOf(path) + 1,
  }));

  return {
    taskId: task.id,
    task: task.task,
    intent: task.intent,
    metrics,
    details: {
      retrievedPaths: uniquePaths.slice(0, 10),
      relevantPaths: task.relevant_files,
      hits,
      misses,
      hitDetails,
      retrievedPathCount: uniquePaths.length,
    },
  };
}

function logTaskResult(result: EvalResult, log: (...args: unknown[]) => void): void {
  const hitIcon = result.details.hits.length > 0 ? '✓' : '✗';
  log(
    `  ${hitIcon} ${result.taskId} [${result.intent.padEnd(12)}] ` +
    `R@10=${result.metrics.recallAt10.toFixed(2)} P@10=${result.metrics.precisionAt10.toFixed(2)} ` +
    `NDCG=${result.metrics.ndcgAt10.toFixed(2)} MRR=${result.metrics.mrr.toFixed(2)} ` +
    `hits=${result.details.hits.length}/${result.details.relevantPaths.length} ` +
    `miss=${result.details.misses.join(',') || 'none'}`
  );
}

async function evaluateTasksSequential(
  tasks: BenchmarkTask[],
  strategy: string,
  runtime: BenchmarkRuntime,
  allChunks: BenchmarkChunk[],
  onResult?: (result: EvalResult) => void
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const task of tasks) {
    const result = await evaluateBenchmarkTask(task, strategy, runtime, allChunks);
    results.push(result);
    onResult?.(result);
  }
  return results;
}

function splitTaskShards(tasks: BenchmarkTask[], workerCount: number): IndexedBenchmarkTask[][] {
  const shards: IndexedBenchmarkTask[][] = Array.from({ length: workerCount }, () => []);
  tasks.forEach((task, index) => {
    shards[index % workerCount].push({ index, task });
  });
  return shards.filter((shard) => shard.length > 0);
}

async function runWorkerShard(
  payload: BenchmarkWorkerPayload,
  onResult?: (index: number, result: EvalResult) => void
): Promise<void> {
  const worker = fileURLToPath(import.meta.url).endsWith('.ts')
    ? new Worker(`
        const { workerData } = require('node:worker_threads');
        import('tsx/esm/api').then(({ tsImport }) => tsImport(workerData.entryUrl, {
          parentURL: workerData.registerBaseUrl,
        })).catch((error) => {
          throw error;
        });
      `, {
        eval: true,
        workerData: {
          ...payload,
          entryUrl: import.meta.url,
          registerBaseUrl: pathToFileURL(`${process.cwd()}/`).href,
        },
      })
    : new Worker(new URL(import.meta.url), {
      workerData: payload,
      execArgv: process.execArgv,
    });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      rejectPromise(error);
    };

    worker.on('message', (message: BenchmarkWorkerMessage) => {
      if (message.type === 'result') {
        onResult?.(message.index, message.result);
      } else if (message.type === 'error') {
        rejectOnce(new Error(`Benchmark worker ${message.workerId} failed: ${message.message}`));
      }
    });
    worker.on('error', (error) => {
      rejectOnce(error);
    });
    worker.on('exit', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Benchmark worker ${payload.workerId} exited with code ${code}`));
    });
  });
}

async function evaluateTasksParallel(input: {
  tasks: BenchmarkTask[];
  strategy: string;
  dbPath: string;
  requestedWorkers: number;
  log: (...args: unknown[]) => void;
}): Promise<EvalResult[]> {
  const workerCount = Math.min(input.requestedWorkers, input.tasks.length);
  const results = new Array<EvalResult | undefined>(input.tasks.length);
  const shards = splitTaskShards(input.tasks, workerCount);

  input.log(`  Evaluating ${input.tasks.length} tasks with ${shards.length} workers`);

  await Promise.all(shards.map((tasks, index) => runWorkerShard({
    workerId: index + 1,
    dbPath: input.dbPath,
    strategy: input.strategy,
    tasks,
  }, (taskIndex, result) => {
    results[taskIndex] = result;
    logTaskResult(result, input.log);
  })));

  const missing = results.findIndex((result) => result === undefined);
  if (missing >= 0) {
    throw new Error(`Benchmark worker result missing for task index ${missing}`);
  }

  return results as EvalResult[];
}

async function runBenchmarkWorker(): Promise<void> {
  if (!parentPort) {
    throw new Error('Benchmark worker started without a parent port');
  }

  const payload = workerData as BenchmarkWorkerPayload;
  const runtime = await createEvaluationRuntime(payload.dbPath);
  try {
    const allChunks = runtime.storage.getAllChunks() as BenchmarkChunk[];
    for (const { index, task } of payload.tasks) {
      const result = await evaluateBenchmarkTask(task, payload.strategy, runtime, allChunks);
      parentPort.postMessage({
        type: 'result',
        workerId: payload.workerId,
        index,
        result,
      } satisfies BenchmarkWorkerMessage);
    }
    parentPort.postMessage({
      type: 'done',
      workerId: payload.workerId,
    } satisfies BenchmarkWorkerMessage);
  } finally {
    runtime.close();
  }
}

// ── Main Evaluation Runner ──────────────────────────────────

async function runEvaluation(options: CliOptions) {
  const benchDir = dirname(fileURLToPath(import.meta.url));
  const dataset = loadBenchmarkDataset(options.dataset);
  const log = (...args: unknown[]) => {
    if (!options.json) console.log(...args);
  };

  log(`\n${'═'.repeat(70)}`);
  log(`  SPACEFOLDING RETRIEVAL BENCHMARK`);
  log(`  Tasks: ${dataset.tasks.length} | Strategy: ${options.strategy} | Workers: ${options.workers}`);
  log(`  Dataset: ${relative(benchDir, options.dataset) || options.dataset}`);
  log(`  Corpus: ${relative(benchDir, options.corpus) || options.corpus}`);
  if (options.maxChunks !== null) {
    log(`  Max chunks: ${options.maxChunks}`);
  }
  log(`${'═'.repeat(70)}\n`);

  const strategies = resolveStrategies(options.strategy);
  const previousMaxChunks = process.env.MAX_CHUNKS;
  if (options.maxChunks !== null) {
    process.env.MAX_CHUNKS = String(options.maxChunks);
  }

  // Create a test pipeline with the Spacefolding codebase ingested
  const dbArtifact = createBenchmarkSqliteArtifact('benchmark-eval');
  const dbPath = dbArtifact.path;
  const runtime = await createEvaluationRuntime(dbPath);

  // Ingest the Spacefolding source code
  const projectRoot = join(benchDir, '..');
  const files = walkDir(options.corpus, options.includeTests);
  log(`Ingesting ${files.length} source files...`);

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const relativePath = projectRelativePath(projectRoot, filePath);
    await runtime.pipeline.ingest('file', content, undefined, relativePath, undefined);
  }

  const allChunks = runtime.storage.getAllChunks() as BenchmarkChunk[];
  log(`Ingested ${allChunks.length} chunks\n`);

  // Run evaluations for each strategy
  const summaries: StrategySummary[] = [];

  for (const strat of strategies) {
    log(`\n${'─'.repeat(70)}`);
    log(`  Strategy: ${strat.toUpperCase()}`);
    log(`${'─'.repeat(70)}\n`);

    const results = options.workers > 1 && dataset.tasks.length > 1
      ? await evaluateTasksParallel({
        tasks: dataset.tasks,
        strategy: strat,
        dbPath,
        requestedWorkers: options.workers,
        log,
      })
      : await evaluateTasksSequential(
        dataset.tasks,
        strat,
        runtime,
        allChunks,
        (result) => logTaskResult(result, log)
      );

    // Compute averages
    const avgMetrics = computeAverageMetrics(results);

    // Print summary
    log(`\n  ${'─'.repeat(50)}`);
    log(`  AVERAGE (${results.length} tasks)`);
    log(`  ${'─'.repeat(50)}`);
    log(`  Recall@5:       ${avgMetrics.recallAt5.toFixed(3)}`);
    log(`  Recall@10:      ${avgMetrics.recallAt10.toFixed(3)}`);
    log(`  Recall@20:      ${avgMetrics.recallAt20.toFixed(3)}`);
    log(`  Precision@5:    ${avgMetrics.precisionAt5.toFixed(3)}`);
    log(`  Precision@10:   ${avgMetrics.precisionAt10.toFixed(3)}`);
    log(`  Precision@20:   ${avgMetrics.precisionAt20.toFixed(3)}`);
    log(`  NDCG@10:        ${avgMetrics.ndcgAt10.toFixed(3)}`);
    log(`  NDCG@20:        ${avgMetrics.ndcgAt20.toFixed(3)}`);
    log(`  MRR:            ${avgMetrics.mrr.toFixed(3)}`);
    log(`  Hits@1:         ${avgMetrics.hitsAt1.toFixed(3)}`);
    log(`  Hits@5:         ${avgMetrics.hitsAt5.toFixed(3)}`);
    log(`  Avg results:    ${avgMetrics.avgResults.toFixed(1)}`);

    // Breakdown by intent
    const intents = [...new Set(results.map((r) => r.intent))];
    log(`\n  By intent:`);
    for (const intent of intents) {
      const intentResults = results.filter((r) => r.intent === intent);
      const avgRecall = intentResults.reduce((s, r) => s + r.metrics.recallAt10, 0) / intentResults.length;
      const avgNdcg = intentResults.reduce((s, r) => s + r.metrics.ndcgAt10, 0) / intentResults.length;
      log(`    ${intent.padEnd(12)} R@10=${avgRecall.toFixed(3)} NDCG=${avgNdcg.toFixed(3)} (${intentResults.length} tasks)`);
    }

    summaries.push({ strategy: strat, averages: avgMetrics, results });
  }

  // Cleanup
  runtime.close();
  dbArtifact.cleanup();

  const report = buildEvaluationReport({
    dataset: options.dataset,
    corpus: options.corpus,
    requestedStrategies: strategies,
    strategies: summaries,
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    log(`\n${'═'.repeat(70)}`);
    log(`  BENCHMARK COMPLETE`);
    if (typeof report.successGate.structuralBeatsKeyword === 'boolean') {
      log(`  Structural beats keyword on strict metrics: ${report.successGate.structuralBeatsKeyword ? 'yes' : 'no'}`);
    } else {
      log(`  Structural beats keyword on strict metrics: missing summaries for ${report.successGate.missingStrategySummaries.join(', ')}`);
    }
    log(`${'═'.repeat(70)}\n`);
  }

  if (options.maxChunks !== null) {
    if (previousMaxChunks === undefined) delete process.env.MAX_CHUNKS;
    else process.env.MAX_CHUNKS = previousMaxChunks;
  }
}

export function walkDir(dir: string, includeTests: boolean): string[] {
  return walkBenchmarkSourceFiles(dir, {
    includeTests,
    extraFileNames: ['.env.example'],
  });
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (!isMainThread) {
  runBenchmarkWorker().catch((err) => {
    parentPort?.postMessage({
      type: 'error',
      workerId: (workerData as Partial<BenchmarkWorkerPayload> | undefined)?.workerId ?? 0,
      message: errorMessage(err),
    } satisfies BenchmarkWorkerMessage);
    process.exit(1);
  });
} else if (isMainModule()) {
  const benchDir = dirname(fileURLToPath(import.meta.url));
  try {
    const options = parseArgs(process.argv.slice(2), benchDir);
    runEvaluation(options).catch((err) => {
      console.error(`Benchmark failed: ${errorMessage(err)}`);
      process.exit(1);
    });
  } catch (err) {
    console.error(`Benchmark failed: ${errorMessage(err)}`);
    process.exit(1);
  }
}
