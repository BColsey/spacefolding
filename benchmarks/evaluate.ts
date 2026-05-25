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

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmarkSqlitePath, removeSqliteArtifacts } from './temp-artifacts.js';

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
}

const ALL_STRATEGIES = ['keyword', 'path-match', 'fts', 'vector', 'symbol-only', 'structural'];
const KNOWN_STRATEGIES = new Set([
  ...ALL_STRATEGIES,
  'hybrid',
  'random',
  'spacefolding',
  'text',
]);
const SUCCESS_GATE_STRATEGIES = ['keyword', 'structural'];

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
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dataset') options.dataset = readOptionValue(argv, i++, arg);
    else if (arg === '--corpus') options.corpus = readOptionValue(argv, i++, arg);
    else if (arg === '--strategy') options.strategy = readOptionValue(argv, i++, arg);
    else if (arg === '--json') options.json = true;
    else if (arg === '--include-tests') options.includeTests = true;
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
  strategy: 'structural' | 'hybrid' | 'vector' | 'text' = 'structural'
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
  storage: any,
  parseStructuralQuery: (query: string) => {
    normalizedIdentifiers: string[];
    identifierParts: string[];
  }
): Promise<string[]> {
  const query = parseStructuralQuery(task.task);
  const identifiers = new Set(query.normalizedIdentifiers);
  const parts = new Set(query.identifierParts);
  const rows = storage.getAllCodeSymbols() as Array<{
    chunkId?: string;
    path?: string;
    name: string;
    normalizedName: string;
  }>;
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

// ── Main Evaluation Runner ──────────────────────────────────

async function runEvaluation(options: CliOptions) {
  const benchDir = dirname(fileURLToPath(import.meta.url));
  const dataset = loadBenchmarkDataset(options.dataset);
  const log = (...args: unknown[]) => {
    if (!options.json) console.log(...args);
  };

  log(`\n${'═'.repeat(70)}`);
  log(`  SPACEFOLDING RETRIEVAL BENCHMARK`);
  log(`  Tasks: ${dataset.tasks.length} | Strategy: ${options.strategy}`);
  log(`  Dataset: ${relative(benchDir, options.dataset) || options.dataset}`);
  log(`  Corpus: ${relative(benchDir, options.corpus) || options.corpus}`);
  log(`${'═'.repeat(70)}\n`);

  const strategies = resolveStrategies(options.strategy);

  // Load the Spacefolding pipeline with real codebase data
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

  // Create a test pipeline with the Spacefolding codebase ingested
  const dbPath = benchmarkSqlitePath('benchmark-eval');
  removeSqliteArtifacts(dbPath);

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

  // Ingest the Spacefolding source code
  const projectRoot = join(benchDir, '..');
  const files = walkDir(options.corpus, options.includeTests);
  log(`Ingesting ${files.length} source files...`);

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const relativePath = relative(projectRoot, filePath);
    await pipeline.ingest('file', content, undefined, relativePath, undefined);
  }

  const allChunks = storage.getAllChunks();
  log(`Ingested ${allChunks.length} chunks\n`);

  // Run evaluations for each strategy
  const summaries: StrategySummary[] = [];

  for (const strat of strategies) {
    log(`\n${'─'.repeat(70)}`);
    log(`  Strategy: ${strat.toUpperCase()}`);
    log(`${'─'.repeat(70)}\n`);

    const results: EvalResult[] = [];

    for (const task of dataset.tasks) {
      const relevantSet = new Set(task.relevant_files);
      let retrievedPaths: string[];

      switch (strat) {
        case 'spacefolding':
        case 'structural':
          retrievedPaths = await spacefoldingRetrieval(task, pipeline, 'structural');
          break;
        case 'hybrid':
          retrievedPaths = await spacefoldingRetrieval(task, pipeline, 'hybrid');
          break;
        case 'fts':
        case 'text':
          retrievedPaths = await spacefoldingRetrieval(task, pipeline, 'text');
          break;
        case 'vector':
          retrievedPaths = await spacefoldingRetrieval(task, pipeline, 'vector');
          break;
        case 'symbol-only':
          retrievedPaths = await symbolOnlyRetrieval(task, storage, parseStructuralQuery);
          break;
        case 'keyword':
          retrievedPaths = await keywordBaseline(task, allChunks);
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

      // Deduplicate paths
      const uniquePaths = [...new Set(retrievedPaths)];

      const metrics = computeMetrics(uniquePaths, relevantSet, task.relevant_files.length);
      const hits = uniquePaths.filter((p) => relevantSet.has(p));
      const misses = task.relevant_files.filter((f) => !uniquePaths.includes(f));
      const hitDetails = hits.map((path) => ({
        path,
        rank: uniquePaths.indexOf(path) + 1,
      }));

      results.push({
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
      });

      // Print per-task result
      const hitIcon = hits.length > 0 ? '✓' : '✗';
      log(
        `  ${hitIcon} ${task.id} [${task.intent.padEnd(12)}] ` +
        `R@10=${metrics.recallAt10.toFixed(2)} P@10=${metrics.precisionAt10.toFixed(2)} ` +
        `NDCG=${metrics.ndcgAt10.toFixed(2)} MRR=${metrics.mrr.toFixed(2)} ` +
        `hits=${hits.length}/${task.relevant_files.length} ` +
        `miss=${misses.join(',') || 'none'}`
      );
    }

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
  pipeline.close();
  removeSqliteArtifacts(dbPath);

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
}

const SKIP_DIRS = new Set([
  '.claude',
  '.codex',
  '.cursor',
  '.git',
  '.hg',
  '.next',
  '.svn',
  '.turbo',
  '.venv',
  '__pycache__',
  'benchmarks',
  'build',
  'coverage',
  'data',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
  'venv',
]);

const BENCHMARK_CONTEXT_FILES = new Set([
  '.env.example',
]);

export function walkDir(dir: string, includeTests: boolean): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) results.push(...walkDir(fullPath, includeTests));
    } else {
      const ext = extname(entry);
      if (
        (
          ['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java'].includes(ext)
          || BENCHMARK_CONTEXT_FILES.has(entry.toLowerCase())
        )
        && (includeTests || !isTestPath(fullPath))
      ) {
        results.push(fullPath);
      }
    }
  }
  return results.sort();
}

function isTestPath(filePath: string): boolean {
  const normalized = filePath.split(/[\\/]+/).join('/');
  return /(^|\/)(__tests__|tests?|spec|fixtures|mocks?)(\/|$)/i.test(normalized)
    || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(normalized)
    || /test_.*\.py$/i.test(normalized)
    || /_test\.go$/i.test(normalized);
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  const benchDir = dirname(fileURLToPath(import.meta.url));
  const options = parseArgs(process.argv.slice(2), benchDir);
  runEvaluation(options).catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}
