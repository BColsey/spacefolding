/**
 * Profile Spacefolding ingest/index and retrieval latency on a local corpus.
 *
 * Usage:
 *   npm run build
 *   npx tsx benchmarks/profile-retrieval.ts \
 *     --corpus /path/to/repo \
 *     --dataset /tmp/spacefolding-heldout-repo.json \
 *     --strategy structural \
 *     --json > /tmp/spacefolding-heldout-profile.json
 *
 * Compare JSON keys for ingest cost (files, chunks, symbols, references,
 * totalTokensEstimate, dbBytes, ingestMs), retrieval latency (queryMs),
 * returned context size (tokensReturned, chunksReturned), and memory.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { projectRelativePath, walkBenchmarkSourceFiles } from './source-files.js';
import { createBenchmarkSqliteArtifact } from './temp-artifacts.js';

interface BenchmarkTask {
  id: string;
  task: string;
}

interface BenchmarkDataset {
  tasks: BenchmarkTask[];
}

type RetrievalStrategy = 'structural' | 'hybrid' | 'vector' | 'text' | 'graph';

export interface CliOptions {
  corpus: string;
  dataset: string;
  strategy: RetrievalStrategy;
  topK: number;
  returnLimit: number;
  maxTokens: number;
  json: boolean;
  includeTests: boolean;
}

interface QueryProfile {
  taskId: string;
  queryMs: number;
  chunksReturned: number;
  retrievalCandidates: number;
  tokensReturned: number;
  topPaths: string[];
}

const benchDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(benchDir, '..');

const SUPPORTED_STRATEGIES = new Set<RetrievalStrategy>(['structural', 'hybrid', 'vector', 'text', 'graph']);

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    corpus: join(projectRoot, 'src'),
    dataset: join(benchDir, 'dataset.json'),
    strategy: 'structural',
    topK: 50,
    returnLimit: 10,
    maxTokens: 50_000,
    json: false,
    includeTests: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--corpus') options.corpus = readOptionValue(argv, i++, arg);
    else if (arg === '--dataset') options.dataset = readOptionValue(argv, i++, arg);
    else if (arg === '--strategy') options.strategy = parseStrategy(readOptionValue(argv, i++, arg));
    else if (arg === '--top-k') options.topK = parsePositiveInt(readOptionValue(argv, i++, arg), 'top-k');
    else if (arg === '--return-limit') options.returnLimit = parsePositiveInt(readOptionValue(argv, i++, arg), 'return-limit');
    else if (arg === '--max-tokens') options.maxTokens = parsePositiveInt(readOptionValue(argv, i++, arg), 'max-tokens');
    else if (arg === '--json') options.json = true;
    else if (arg === '--include-tests') options.includeTests = true;
    else throw new Error(`Unknown argument: ${arg}`);
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

function parseStrategy(value: string): RetrievalStrategy {
  if (!SUPPORTED_STRATEGIES.has(value as RetrievalStrategy)) {
    throw new Error(`--strategy must be one of: ${[...SUPPORTED_STRATEGIES].join(', ')}`);
  }
  return value as RetrievalStrategy;
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
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
      `Profiler dataset task ${index + 1} field ${field} must be a non-empty string: ${datasetPath}`
    );
  }
  return value;
}

export function parseProfileDataset(data: unknown, datasetPath: string): BenchmarkDataset {
  if (!isRecord(data) || !Array.isArray(data.tasks)) {
    throw new Error(`Profiler dataset must contain a tasks array: ${datasetPath}`);
  }
  if (data.tasks.length === 0) {
    throw new Error(`Dataset has no tasks: ${datasetPath}`);
  }

  return {
    tasks: data.tasks.map((task, index) => {
      if (!isRecord(task)) {
        throw new Error(`Profiler dataset task ${index + 1} must be an object: ${datasetPath}`);
      }
      return {
        id: requireTaskString(task, 'id', index, datasetPath),
        task: requireTaskString(task, 'task', index, datasetPath),
      };
    }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function loadProfileDataset(datasetPath: string): BenchmarkDataset {
  let raw: string;
  try {
    raw = readFileSync(datasetPath, 'utf-8');
  } catch (error) {
    throw new Error(`Unable to read profiler dataset JSON at ${datasetPath}: ${errorMessage(error)}`);
  }

  try {
    return parseProfileDataset(JSON.parse(raw) as unknown, datasetPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Malformed profiler dataset JSON at ${datasetPath}: ${error.message}`);
    }
    throw error;
  }
}

export function walkProfileCorpus(dir: string, includeTests: boolean): string[] {
  return walkBenchmarkSourceFiles(dir, { includeTests });
}

function summarize(values: number[]): { min: number; p50: number; p95: number; max: number; mean: number } {
  if (values.length === 0) return { min: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  return {
    min: sorted[0],
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted[sorted.length - 1],
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

function dbBytes(dbPath: string): number {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
    .filter((path) => existsSync(path))
    .reduce((sum, path) => sum + statSync(path).size, 0);
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  if (!existsSync(options.corpus)) throw new Error(`Corpus not found: ${options.corpus}`);
  if (!existsSync(options.dataset)) throw new Error(`Dataset not found: ${options.dataset}`);

  const dataset = loadProfileDataset(options.dataset);
  const log = (...args: unknown[]) => {
    if (!options.json) console.log(...args);
  };

  const { createRepository } = await import('../dist/storage/repository.js');
  const { DeterministicTokenEstimator } = await import('../dist/providers/token-estimator.js');
  const { DeterministicEmbeddingProvider } = await import('../dist/providers/deterministic-embedding.js');
  const { DeterministicCompressionProvider } = await import('../dist/providers/deterministic-compression.js');
  const { SimpleDependencyAnalyzer } = await import('../dist/providers/dependency-analyzer.js');
  const { ContextScorer } = await import('../dist/core/scorer.js');
  const { ContextRouter, DEFAULT_ROUTING_CONFIG } = await import('../dist/core/router.js');
  const { ContextIngester } = await import('../dist/core/ingester.js');
  const { PipelineOrchestrator } = await import('../dist/pipeline/orchestrator.js');

  const dbArtifact = createBenchmarkSqliteArtifact('profile');
  const dbPath = dbArtifact.path;

  const storage = createRepository(dbPath);
  const tokenEstimator = new DeterministicTokenEstimator();
  const embeddingProvider = new DeterministicEmbeddingProvider();
  const pipeline = new PipelineOrchestrator(
    storage,
    new ContextScorer(DEFAULT_ROUTING_CONFIG, embeddingProvider, tokenEstimator),
    new ContextRouter(DEFAULT_ROUTING_CONFIG),
    new DeterministicCompressionProvider(),
    new SimpleDependencyAnalyzer(),
    new ContextIngester(tokenEstimator),
    embeddingProvider
  );

  const files = walkProfileCorpus(options.corpus, options.includeTests);
  const fileBytes = files.reduce((sum, filePath) => sum + statSync(filePath).size, 0);
  log(`Profiling ${files.length} files from ${options.corpus}`);

  const ingestStart = performance.now();
  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    await pipeline.ingest('file', content, undefined, projectRelativePath(projectRoot, filePath), undefined);
  }
  const ingestMs = performance.now() - ingestStart;

  const chunks = storage.getAllChunks();
  const stats = pipeline.getStats();
  const symbols = storage.getAllCodeSymbols();
  let referenceCount = 0;
  for (const chunk of chunks) {
    referenceCount += storage.getCodeReferences(chunk.id).length;
  }

  const profiles: QueryProfile[] = [];
  for (const task of dataset.tasks) {
    const queryStart = performance.now();
    const result = await pipeline.retrieve(task.task, options.maxTokens, {
      strategy: options.strategy,
      topK: options.topK,
      returnLimit: options.returnLimit,
      maxHops: 0,
    });
    const queryMs = performance.now() - queryStart;
    profiles.push({
      taskId: task.id,
      queryMs,
      chunksReturned: result.chunks.length,
      retrievalCandidates: result.retrieval.length,
      tokensReturned: result.totalTokens,
      topPaths: result.chunks.map((chunk: any) => chunk.path).filter(Boolean).slice(0, 5),
    });
  }

  const queryMs = summarize(profiles.map((profile) => profile.queryMs));
  const tokensReturned = summarize(profiles.map((profile) => profile.tokensReturned));
  const chunksReturned = summarize(profiles.map((profile) => profile.chunksReturned));
  const memory = process.memoryUsage();

  const output = {
    corpus: options.corpus,
    dataset: options.dataset,
    strategy: options.strategy,
    files: files.length,
    fileBytes,
    chunks: chunks.length,
    totalTokensEstimate: stats.totalTokensEstimate,
    symbols: symbols.length,
    references: referenceCount,
    dbBytes: dbBytes(dbPath),
    ingestMs,
    ingestFilesPerSecond: files.length / Math.max(0.001, ingestMs / 1000),
    queryCount: profiles.length,
    queryMs,
    tokensReturned,
    chunksReturned,
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
    },
    slowestQueries: [...profiles]
      .sort((a, b) => b.queryMs - a.queryMs)
      .slice(0, 5),
  };

  pipeline.close();
  dbArtifact.cleanup();

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  log(`Files: ${output.files} | Chunks: ${output.chunks} | Symbols: ${output.symbols} | References: ${output.references}`);
  log(`Ingest: ${output.ingestMs.toFixed(0)} ms (${output.ingestFilesPerSecond.toFixed(1)} files/sec)`);
  log(`DB size: ${(output.dbBytes / 1024 / 1024).toFixed(1)} MiB | Tokens: ${output.totalTokensEstimate.toLocaleString()}`);
  log(`Query latency ms: mean=${queryMs.mean.toFixed(1)} p50=${queryMs.p50.toFixed(1)} p95=${queryMs.p95.toFixed(1)} max=${queryMs.max.toFixed(1)}`);
  log(`Returned tokens: mean=${tokensReturned.mean.toFixed(0)} p95=${tokensReturned.p95.toFixed(0)} max=${tokensReturned.max.toFixed(0)}`);
  log(`Returned chunks: mean=${chunksReturned.mean.toFixed(1)} p95=${chunksReturned.p95.toFixed(1)} max=${chunksReturned.max.toFixed(0)}`);
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`Profile failed: ${errorMessage(error)}`);
    process.exit(1);
  });
}
