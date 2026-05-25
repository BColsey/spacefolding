/**
 * End-to-End A/B Benchmark Framework
 *
 * Simulates a real coding workflow to answer the product question:
 *   "Does using Spacefolding help an LLM produce better code?"
 *
 * For each realistic coding task, compares:
 *   BASELINE  — manually reading all relevant files (no retrieval)
 *   SPACEFOLD — using retrieve_context to find the right chunks
 *
 * Measures: file recall, token budget efficiency, precision, and savings.
 *
 * Usage:
 *   npx tsx benchmarks/e2e-benchmark.ts
 *   EMBEDDING_PROVIDER=deterministic npx tsx benchmarks/e2e-benchmark.ts
 */

import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RetrievalStrategy } from '../src/types/index.js';
import { RETRIEVAL_STRATEGIES } from '../src/types/index.js';
import { projectRelativePath, walkBenchmarkSourceFiles } from './source-files.js';
import { benchmarkSqlitePath, createBenchmarkSqliteArtifact } from './temp-artifacts.js';

// ── Types ────────────────────────────────────────────────────────

export interface E2ETask {
  id: string;
  name: string;
  description: string;
  /** Files a developer would need to read to complete the task */
  expectedFiles: string[];
  /** Brief description of what the task entails */
  expectedChanges: string;
}

export interface BaselineResult {
  filesNeeded: number;
  /** Sum of tokens across all expected files (entire file contents) */
  totalTokensAllFiles: number;
  /** Tokens to read the entire codebase (what you'd need without retrieval) */
  totalTokensCodebase: number;
  /** Total number of files in the codebase */
  totalFilesCodebase: number;
}

export interface SpacefoldResult {
  filesFound: string[];
  filesMissed: string[];
  recall: number;
  precision: number;
  tokensUsed: number;
  tokensBudget: number;
  utilization: number;
  /** Number of chunks returned */
  chunksReturned: number;
  /** Relevant chunks (from expected files) */
  relevantChunks: number;
  tokensVsCurrent: number;
  recallVsCurrent: number;
  precisionVsCurrent: number;
  tokensVsFullCodebase: number;
  returnedMoreThanCodebase: boolean;
}

export interface TaskComparison {
  task: E2ETask;
  baseline: BaselineResult;
  spacefold: SpacefoldResult;
  /** % token savings vs reading only the expected files */
  savingsVsRelevant: number;
  /** % token savings vs reading the entire codebase */
  savingsVsCodebase: number;
}

const SUPPORTED_STRATEGIES = RETRIEVAL_STRATEGIES;

export interface CliOptions {
  strategy: RetrievalStrategy;
  json: boolean;
  dataset?: string;
}

interface SelectedVsCurrentDeltas {
  /** Positive means selected retrieval returned fewer tokens than current hybrid. */
  averageTokens: number;
  /** Positive means selected retrieval found more expected files than current hybrid. */
  averageRecall: number;
  /** Positive means selected retrieval returned a higher ratio of expected files than current hybrid. */
  averagePrecision: number;
}

interface E2ESummary {
  averageRecall: number;
  averagePrecision: number;
  totalFilesHit: number;
  totalFilesNeeded: number;
  totalTokens: number;
  averageTokens: number;
  totalCodebaseTokens: number;
  averageTokensVsCurrent: number;
  averageRecallVsCurrent: number;
  averagePrecisionVsCurrent: number;
  selectedVsCurrentDeltas: SelectedVsCurrentDeltas;
  currentVsStructuralDeltas: SelectedVsCurrentDeltas | null;
  tasksReturningMoreThanCodebase: string[];
}

interface E2ESuccessGate {
  focusedRetrievalPasses: boolean;
  averageRecall: number;
  averagePrecision: number;
  averageTokens: number;
  recallThreshold: number;
  precisionThreshold: number;
  averageTokensCeiling: number;
  tasksReturningMoreThanCodebase: string[];
}

export interface E2EReport {
  strategy: CliOptions['strategy'];
  summary: E2ESummary;
  comparisons: TaskComparison[];
  successGate: E2ESuccessGate;
}

export function resolveBenchmarkDbPath(): string {
  return benchmarkSqlitePath('e2e-benchmark');
}

// ── Test Tasks ───────────────────────────────────────────────────
// Realistic coding tasks against the Spacefolding codebase itself.

const TASKS: E2ETask[] = [
  {
    id: 'E01',
    name: 'Add OpenAI embedding provider',
    description:
      'Add a new embedding provider that uses the OpenAI embeddings API. It should implement the EmbeddingProvider interface and be selectable via the EMBEDDING_PROVIDER environment variable.',
    expectedFiles: [
      'src/providers/local-embedding.ts',
      'src/types/index.ts',
      'src/cli/index.ts',
    ],
    expectedChanges:
      'Create a new OpenAI embedding provider, add the provider type, and wire it into the CLI startup.',
  },
  {
    id: 'E02',
    name: 'Wire reranker into pipeline',
    description:
      'Fix the reranker so it is actually wired into the retrieval pipeline. Currently the deterministic reranker exists but is never called during retrieval.',
    expectedFiles: [
      'src/providers/deterministic-reranker.ts',
      'src/core/retriever.ts',
      'src/pipeline/orchestrator.ts',
    ],
    expectedChanges:
      'Add reranker invocation after hybrid retrieval in the retriever, and accept a reranker instance in the pipeline constructor.',
  },
  {
    id: 'E03',
    name: 'Add TTL-based chunk eviction',
    description:
      'Add support for TTL-based chunk eviction so that stale context is automatically removed after a configurable time period.',
    expectedFiles: [
      'src/storage/repository.ts',
      'src/pipeline/orchestrator.ts',
    ],
    expectedChanges:
      'Add a lastAccessed timestamp to chunks, add a pruneStale method to the repository, and call it from the orchestrator.',
  },
  {
    id: 'E04',
    name: 'Per-file statistics in web UI',
    description:
      'Switch the web UI to show per-file statistics (chunk count, total tokens, tier breakdown) instead of just an aggregate summary.',
    expectedFiles: [
      'src/web/server.ts',
      'src/pipeline/orchestrator.ts',
    ],
    expectedChanges:
      'Add a /api/stats endpoint that returns per-file breakdown using the orchestrator getStats method, and render it in the web UI.',
  },
  {
    id: 'E05',
    name: 'Incremental file re-ingestion',
    description:
      'Add support for incremental file re-ingestion on change. When a file is modified, only the changed chunks should be re-ingested rather than the entire file.',
    expectedFiles: [
      'src/core/watcher.ts',
      'src/pipeline/orchestrator.ts',
    ],
    expectedChanges:
      'Enhance the file watcher to detect modifications, compute a diff of changed regions, and re-ingest only affected chunks via the orchestrator.',
  },
  {
    id: 'E06',
    name: 'Add batch delete MCP tool',
    description:
      'Add a new MCP tool for batch deleting chunks by source or path pattern, so users can clean up stale context without deleting one chunk at a time.',
    expectedFiles: [
      'src/mcp/server.ts',
      'src/storage/repository.ts',
      'src/types/index.ts',
    ],
    expectedChanges:
      'Add a batchDelete tool to the MCP server, implement a deleteByFilter method in the repository, and define the filter type.',
  },
  {
    id: 'E07',
    name: 'Fix budget controller overflow',
    description:
      'The budget controller sometimes includes too many chunks and exceeds the token budget when sibling collapse produces a larger parent chunk. Fix this edge case.',
    expectedFiles: [
      'src/core/budget.ts',
      'src/core/retriever.ts',
    ],
    expectedChanges:
      'Add a post-fill validation pass in fillBudget that re-checks total tokens after sibling collapse and removes the lowest-priority items if over budget.',
  },
  {
    id: 'E08',
    name: 'Add query expansion to planner',
    description:
      'The query planner currently produces a single retrieval query. Enhance it to generate multiple expanded queries for better coverage of ambiguous tasks.',
    expectedFiles: [
      'src/core/query-planner.ts',
      'src/core/retriever.ts',
    ],
    expectedChanges:
      'Add a generateExpandedQueries method to the query planner that produces synonyms and broader/narrower variants, then run multiple retrievals and merge results.',
  },
  {
    id: 'E09',
    name: 'Add compression quality metric',
    description:
      'Add a quality metric to compression results that measures how much semantic information is preserved, so users can tune compression aggressiveness.',
    expectedFiles: [
      'src/providers/deterministic-compression.ts',
      'src/types/index.ts',
      'src/pipeline/orchestrator.ts',
    ],
    expectedChanges:
      'Add a qualityScore field to CompressionResult, compute it from keyword overlap in the deterministic provider, and expose it through the pipeline.',
  },
  {
    id: 'E10',
    name: 'Add context type to web display',
    description:
      'The web UI currently shows chunk text but not the classified context type. Add the type badge (constraint, instruction, code, etc.) to the chunk display.',
    expectedFiles: [
      'src/web/server.ts',
      'src/core/classifier.ts',
    ],
    expectedChanges:
      'Include the chunk type in the API response from the web server and add a styled badge element in the HTML for each type.',
  },
];

// ── Helpers ──────────────────────────────────────────────────────

function walkDir(dir: string): string[] {
  return walkBenchmarkSourceFiles(dir, { extensions: ['.ts'] });
}

/** Estimate tokens for a string (rough: words * 1.3) */
function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.3);
}

/** Format savings percentage: positive = less tokens used (good) */
function fmtSavings(v: number): string {
  return v >= 0 ? `${v.toFixed(0)}% saved` : `+${Math.abs(v).toFixed(0)}% more`;
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
      `E2E dataset task ${index + 1} field ${field} must be a non-empty string: ${datasetPath}`
    );
  }
  return value;
}

function optionalStringField(task: Record<string, unknown>, field: string): string | undefined {
  const value = task[field];
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : undefined;
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
      `E2E dataset task ${index + 1} field ${field} must be an array of strings: ${datasetPath}`
    );
  }
  return value;
}

export function parseE2EDatasetTasks(data: unknown, datasetPath: string): E2ETask[] {
  if (!isRecord(data) || !Array.isArray(data.tasks)) {
    throw new Error(`E2E dataset must contain a tasks array: ${datasetPath}`);
  }
  if (data.tasks.length === 0) {
    throw new Error(`E2E dataset has no tasks: ${datasetPath}`);
  }

  return data.tasks.map((task, index) => {
    if (!isRecord(task)) {
      throw new Error(`E2E dataset task ${index + 1} must be an object: ${datasetPath}`);
    }

    const id = requireStringField(task, 'id', index, datasetPath);
    const intent = requireStringField(task, 'intent', index, datasetPath);
    const taskText = optionalStringField(task, 'task');
    const description = optionalStringField(task, 'description');
    const text = taskText || description;
    if (!text) {
      throw new Error(
        `E2E dataset task ${index + 1} field task or description must be a non-empty string: ${datasetPath}`
      );
    }

    return {
      id,
      name: `${intent}: ${text.slice(0, 40)}`,
      description: text,
      expectedFiles: requireStringArrayField(task, 'relevant_files', index, datasetPath),
      expectedChanges: `Complete the ${intent} task described above.`,
    };
  });
}

export function loadE2EDatasetTasks(datasetPath: string): E2ETask[] {
  let raw: string;
  try {
    raw = readFileSync(datasetPath, 'utf-8');
  } catch (error) {
    throw new Error(`Unable to read E2E dataset JSON at ${datasetPath}: ${errorMessage(error)}`);
  }

  try {
    return parseE2EDatasetTasks(JSON.parse(raw) as unknown, datasetPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Malformed E2E dataset JSON at ${datasetPath}: ${error.message}`);
    }
    throw error;
  }
}

function parseStrategy(value: string): RetrievalStrategy {
  if (!SUPPORTED_STRATEGIES.includes(value as RetrievalStrategy)) {
    throw new Error(`--strategy must be one of: ${SUPPORTED_STRATEGIES.join(', ')}`);
  }
  return value as RetrievalStrategy;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { strategy: 'structural', json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--strategy') {
      options.strategy = parseStrategy(readOptionValue(argv, i++, arg));
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--dataset') {
      options.dataset = readOptionValue(argv, i++, arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
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

const FOCUSED_RECALL_THRESHOLD = 0.95;
const FOCUSED_PRECISION_THRESHOLD = 0.35;
const FOCUSED_AVERAGE_TOKENS_CEILING = 13_000;

export function buildE2EReport(input: {
  strategy: CliOptions['strategy'];
  comparisons: TaskComparison[];
}): E2EReport {
  if (input.comparisons.length === 0) {
    throw new Error('Cannot build E2E benchmark report for an empty comparison set');
  }

  const totalFilesHit = input.comparisons.reduce(
    (sum, c) => sum + c.spacefold.filesFound.length,
    0
  );
  const totalFilesNeeded = input.comparisons.reduce(
    (sum, c) => sum + c.baseline.filesNeeded,
    0
  );
  const totalTokens = input.comparisons.reduce(
    (sum, c) => sum + c.spacefold.tokensUsed,
    0
  );
  const averageRecall =
    input.comparisons.reduce((sum, c) => sum + c.spacefold.recall, 0) /
    input.comparisons.length;
  const averagePrecision =
    input.comparisons.reduce((sum, c) => sum + c.spacefold.precision, 0) /
    input.comparisons.length;
  const averageTokens = totalTokens / input.comparisons.length;
  const totalCodebaseTokens = input.comparisons[0].baseline.totalTokensCodebase;
  const averageTokensVsCurrent =
    input.comparisons.reduce((sum, c) => sum + c.spacefold.tokensVsCurrent, 0) /
    input.comparisons.length;
  const averageRecallVsCurrent =
    input.comparisons.reduce((sum, c) => sum + c.spacefold.recallVsCurrent, 0) /
    input.comparisons.length;
  const averagePrecisionVsCurrent =
    input.comparisons.reduce((sum, c) => sum + c.spacefold.precisionVsCurrent, 0) /
    input.comparisons.length;
  const tasksReturningMoreThanCodebase = input.comparisons
    .filter((c) => c.spacefold.returnedMoreThanCodebase)
    .map((c) => c.task.id);
  const selectedVsCurrentDeltas = {
    averageTokens: averageTokensVsCurrent,
    averageRecall: averageRecallVsCurrent,
    averagePrecision: averagePrecisionVsCurrent,
  };

  return {
    strategy: input.strategy,
    summary: {
      averageRecall,
      averagePrecision,
      totalFilesHit,
      totalFilesNeeded,
      totalTokens,
      averageTokens,
      totalCodebaseTokens,
      averageTokensVsCurrent,
      averageRecallVsCurrent,
      averagePrecisionVsCurrent,
      selectedVsCurrentDeltas,
      currentVsStructuralDeltas:
        input.strategy === 'structural' ? selectedVsCurrentDeltas : null,
      tasksReturningMoreThanCodebase,
    },
    comparisons: input.comparisons,
    successGate: {
      focusedRetrievalPasses:
        averageRecall >= FOCUSED_RECALL_THRESHOLD &&
        averagePrecision >= FOCUSED_PRECISION_THRESHOLD &&
        averageTokens <= FOCUSED_AVERAGE_TOKENS_CEILING &&
        averageTokens < totalCodebaseTokens &&
        averageTokensVsCurrent > 0 &&
        averageRecallVsCurrent > 0 &&
        averagePrecisionVsCurrent > 0 &&
        tasksReturningMoreThanCodebase.length === 0,
      averageRecall,
      averagePrecision,
      averageTokens,
      recallThreshold: FOCUSED_RECALL_THRESHOLD,
      precisionThreshold: FOCUSED_PRECISION_THRESHOLD,
      averageTokensCeiling: FOCUSED_AVERAGE_TOKENS_CEILING,
      tasksReturningMoreThanCodebase,
    },
  };
}

// ── Main ─────────────────────────────────────────────────────────

async function runE2EBenchmark(options: CliOptions) {
  const benchDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(benchDir, '..');
  const log = (...args: unknown[]) => {
    if (!options.json) console.log(...args);
  };

  // Resolve task list: --dataset or hardcoded TASKS
  let tasks: E2ETask[] = TASKS;
  if (options.dataset) {
    const datasetPath = options.dataset.startsWith('/')
      ? options.dataset
      : join(projectRoot, options.dataset);
    tasks = loadE2EDatasetTasks(datasetPath);
  }

  log(`\n${'='.repeat(78)}`);
  log(`  END-TO-END A/B BENCHMARK`);
  log(`  Tasks: ${tasks.length} | Strategy: ${options.strategy}${options.dataset ? ` | Dataset: ${options.dataset}` : ''}`);
  log(`  Measures: file recall, token efficiency, precision`);
  log(`${'='.repeat(78)}\n`);

  // ── Build pipeline ──────────────────────────────────────────────

  const { createRepository } = await import('../dist/storage/repository.js');
  const { DeterministicTokenEstimator } = await import(
    '../dist/providers/token-estimator.js'
  );
  const { DeterministicEmbeddingProvider } = await import(
    '../dist/providers/deterministic-embedding.js'
  );
  const { DeterministicCompressionProvider } = await import(
    '../dist/providers/deterministic-compression.js'
  );
  const { SimpleDependencyAnalyzer } = await import(
    '../dist/providers/dependency-analyzer.js'
  );
  const { ContextScorer } = await import('../dist/core/scorer.js');
  const { ContextRouter, DEFAULT_ROUTING_CONFIG } = await import(
    '../dist/core/router.js'
  );
  const { ContextIngester } = await import('../dist/core/ingester.js');
  const { PipelineOrchestrator } = await import(
    '../dist/pipeline/orchestrator.js'
  );

  // Support EMBEDDING_PROVIDER=local for real ONNX embeddings
  const embeddingProviderEnv = process.env.EMBEDDING_PROVIDER ?? 'deterministic';
  const dbArtifact = createBenchmarkSqliteArtifact('e2e-benchmark');
  const dbPath = dbArtifact.path;

  let embeddingProvider;
  if (embeddingProviderEnv === 'local') {
    const { LocalEmbeddingProvider } = await import(
      '../dist/providers/local-embedding.js'
    );
    const modelId = process.env.EMBEDDING_MODEL ?? 'Xenova/bge-small-en-v1.5';
    log(`  Embedding provider: local (${modelId})`);
    embeddingProvider = new LocalEmbeddingProvider(modelId);
  } else {
    log(`  Embedding provider: deterministic`);
    embeddingProvider = new DeterministicEmbeddingProvider();
  }

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

  // ── Ingest source files ─────────────────────────────────────────

  const srcDir = join(projectRoot, 'src');
  const files = walkDir(srcDir);
  log(`Ingesting ${files.length} source files...`);

  // Build a map of relative path -> file content for baseline calculation
  const fileContents = new Map<string, string>();

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const relativePath = projectRelativePath(projectRoot, filePath);
    fileContents.set(relativePath, content);
    await pipeline.ingest('file', content, undefined, relativePath, undefined);
  }

  const allChunks = storage.getAllChunks();
  log(`Ingested ${allChunks.length} chunks\n`);

  // Compute total codebase tokens for baseline comparison
  const totalCodebaseTokens = [...fileContents.values()].reduce(
    (sum, content) => sum + estimateTokens(content),
    0
  );
  const totalCodebaseFiles = fileContents.size;

  // ── Run comparison ──────────────────────────────────────────────

  const comparisons: TaskComparison[] = [];

  const TOKEN_BUDGET = 50_000; // Realistic budget for a coding task

  for (const task of tasks) {
    log(
      `${'─'.repeat(78)}\n  Task ${task.id}: ${task.name}\n${'─'.repeat(78)}`
    );
    log(`  "${task.description.slice(0, 90)}..."`);
    log(
      `  Expected files: ${task.expectedFiles.join(', ')}\n`
    );

    // ── Baseline: read all expected files ──────────────────────────

    let baselineTotalTokens = 0;
    for (const expectedPath of task.expectedFiles) {
      const content = fileContents.get(expectedPath);
      if (content) {
        baselineTotalTokens += estimateTokens(content);
      }
    }

    const baseline: BaselineResult = {
      filesNeeded: task.expectedFiles.length,
      totalTokensAllFiles: baselineTotalTokens,
      totalTokensCodebase: totalCodebaseTokens,
      totalFilesCodebase: totalCodebaseFiles,
    };

    log(
      `  BASELINE: ${baseline.filesNeeded} relevant files (${baseline.totalTokensAllFiles.toLocaleString()} tokens), ` +
        `entire codebase: ${totalCodebaseFiles} files (${totalCodebaseTokens.toLocaleString()} tokens)`
    );

    // ── Spacefolding: retrieve with the task description ───────────

    const currentResult = await pipeline.retrieve(
      task.description,
      TOKEN_BUDGET,
      {
        strategy: 'hybrid',
        topK: 15,
        maxHops: 2,
      }
    );
    const expectedSet = new Set(task.expectedFiles);
    const currentPaths = new Set(
      currentResult.chunks
        .map((c: any) => c.path)
        .filter(Boolean) as string[]
    );
    const currentRecall =
      task.expectedFiles.length > 0
        ? task.expectedFiles.filter((f) => currentPaths.has(f)).length / task.expectedFiles.length
        : 0;
    const currentPrecision =
      currentPaths.size > 0
        ? [...currentPaths].filter((p) => expectedSet.has(p)).length / currentPaths.size
        : 0;

    const retrievalResult = await pipeline.retrieve(
      task.description,
      TOKEN_BUDGET,
      {
        strategy: options.strategy,
        topK: 15,
        maxHops: 0,
      }
    );

    const returnedPaths = new Set(
      retrievalResult.chunks
        .map((c: any) => c.path)
        .filter(Boolean) as string[]
    );
    const filesHit = task.expectedFiles.filter((f) => returnedPaths.has(f));
    const filesMissed = task.expectedFiles.filter(
      (f) => !returnedPaths.has(f)
    );

    const recall =
      task.expectedFiles.length > 0
        ? filesHit.length / task.expectedFiles.length
        : 0;
    const precision =
      returnedPaths.size > 0
        ? [...returnedPaths].filter((p) => expectedSet.has(p)).length /
          returnedPaths.size
        : 0;

    // Count relevant chunks (chunks from expected files)
    const relevantChunks = retrievalResult.chunks.filter((c: any) =>
      expectedSet.has(c.path)
    ).length;

    const spacefold: SpacefoldResult = {
      filesFound: filesHit,
      filesMissed,
      recall,
      precision,
      tokensUsed: retrievalResult.totalTokens,
      tokensBudget: retrievalResult.budget,
      utilization: retrievalResult.utilization,
      chunksReturned: retrievalResult.chunks.length,
      relevantChunks,
      tokensVsCurrent: currentResult.totalTokens - retrievalResult.totalTokens,
      recallVsCurrent: recall - currentRecall,
      precisionVsCurrent: precision - currentPrecision,
      tokensVsFullCodebase: retrievalResult.totalTokens - totalCodebaseTokens,
      returnedMoreThanCodebase: retrievalResult.totalTokens > totalCodebaseTokens,
    };

    const savingsVsRelevant =
      baseline.totalTokensAllFiles > 0
        ? ((baseline.totalTokensAllFiles - spacefold.tokensUsed) /
            baseline.totalTokensAllFiles) *
          100
        : 0;
    const savingsVsCodebase =
      totalCodebaseTokens > 0
        ? ((totalCodebaseTokens - spacefold.tokensUsed) / totalCodebaseTokens) *
          100
        : 0;

    log(
      `  SPACEFOLD: ${filesHit.length}/${task.expectedFiles.length} files found, ` +
        `${spacefold.tokensUsed.toLocaleString()} tokens used / ${spacefold.tokensBudget.toLocaleString()} budget ` +
        `(${(spacefold.utilization * 100).toFixed(1)}% util)`
    );
    log(
      `            recall=${recall.toFixed(2)} precision=${precision.toFixed(2)} ` +
        `${spacefold.chunksReturned} chunks (${spacefold.relevantChunks} relevant)`
    );
    log(
      `            vs codebase: ${fmtSavings(savingsVsCodebase)}`
    );
    log(
      `            vs current hybrid: ${spacefold.tokensVsCurrent >= 0 ? `${spacefold.tokensVsCurrent.toLocaleString()} fewer` : `${Math.abs(spacefold.tokensVsCurrent).toLocaleString()} more`} tokens, ` +
        `recall delta=${spacefold.recallVsCurrent.toFixed(2)}, precision delta=${spacefold.precisionVsCurrent.toFixed(2)}`
    );
    if (filesMissed.length > 0) {
      log(`            missed: ${filesMissed.join(', ')}`);
    }

    comparisons.push({
      task,
      baseline,
      spacefold,
      savingsVsRelevant,
      savingsVsCodebase,
    });
  }

  // ── Summary comparison table ────────────────────────────────────

  log(`\n\n${'='.repeat(78)}`);
  log(`  COMPARISON TABLE`);
  log(`${'='.repeat(78)}\n`);

  // Table header
  const col = (s: string, w: number) => s.padEnd(w);
  const hdr = [
    col('Task', 6),
    col('Name', 28),
    col('Relevant', 8),
    col('Relev Tkns', 11),
    col('SF Files', 9),
    col('SF Tokens', 10),
    col('Recall', 7),
    col('Precis', 7),
    col('vs Codebase', 12),
  ].join(' ');
  log(`  ${hdr}`);
  log(`  ${'─'.repeat(hdr.length)}`);

  let totalBaseTokens = 0;
  let totalSfTokens = 0;
  let totalRecall = 0;
  let totalPrecision = 0;
  let totalFilesHit = 0;
  let totalFilesNeeded = 0;

  for (const c of comparisons) {
    const sfFilesStr = `${c.spacefold.filesFound.length}/${c.baseline.filesNeeded}`;
    const row = [
      col(c.task.id, 6),
      col(c.task.name.length > 26 ? c.task.name.slice(0, 24) + '..' : c.task.name, 28),
      col(`${c.baseline.filesNeeded}`, 8),
      col(`${c.baseline.totalTokensAllFiles.toLocaleString()}`, 11),
      col(sfFilesStr, 9),
      col(`${c.spacefold.tokensUsed.toLocaleString()}`, 10),
      col(c.spacefold.recall.toFixed(2), 7),
      col(c.spacefold.precision.toFixed(2), 7),
      col(fmtSavings(c.savingsVsCodebase), 12),
    ].join(' ');
    log(`  ${row}`);

    totalBaseTokens += c.baseline.totalTokensAllFiles;
    totalSfTokens += c.spacefold.tokensUsed;
    totalRecall += c.spacefold.recall;
    totalPrecision += c.spacefold.precision;
    totalFilesHit += c.spacefold.filesFound.length;
    totalFilesNeeded += c.baseline.filesNeeded;
  }

  // Averages row
  const avgRecall = totalRecall / comparisons.length;
  const avgPrecision = totalPrecision / comparisons.length;
  const overallCodebaseSavings =
    totalCodebaseTokens * comparisons.length > 0
      ? ((totalCodebaseTokens * comparisons.length - totalSfTokens) /
          (totalCodebaseTokens * comparisons.length)) *
        100
      : 0;

  log(`  ${'─'.repeat(hdr.length)}`);
  const avgRow = [
    col('', 6),
    col(`AVERAGE (${comparisons.length} tasks)`, 28),
    col('', 8),
    col(`${totalBaseTokens.toLocaleString()}`, 11),
    col(`${totalFilesHit}/${totalFilesNeeded}`, 9),
    col(`${totalSfTokens.toLocaleString()}`, 10),
    col(avgRecall.toFixed(2), 7),
    col(avgPrecision.toFixed(2), 7),
    col(fmtSavings(overallCodebaseSavings), 12),
  ].join(' ');
  log(`  ${avgRow}`);
  log(`\n  Note: "vs Codebase" shows token savings compared to reading all ${totalCodebaseFiles} files (${totalCodebaseTokens.toLocaleString()} tokens)`);
  log(`        Positive savings = Spacefold uses fewer tokens; "+X% more" = Spacefold uses more tokens`);
  if (embeddingProviderEnv === 'local') {
    log(`        Using real ONNX embeddings (${process.env.EMBEDDING_MODEL ?? 'Xenova/bge-small-en-v1.5'}).`);
  } else {
    log(`        With deterministic (hash-based) embeddings, results approximate random retrieval.`);
    log(`        Real embeddings significantly improve recall and precision.`);
  }

  // ── Per-task detail ──────────────────────────────────────────────

  log(`\n\n${'='.repeat(78)}`);
  log(`  PER-TASK DETAIL`);
  log(`${'='.repeat(78)}\n`);

  for (const c of comparisons) {
    const icon = c.spacefold.filesMissed.length === 0 ? 'OK' : 'MISS';
    log(`  [${icon}] ${c.task.id}: ${c.task.name}`);
    log(`       Expected: ${c.task.expectedFiles.join(', ')}`);
    log(`       Found:    ${c.spacefold.filesFound.join(', ') || '(none)'}`);
    if (c.spacefold.filesMissed.length > 0) {
      log(
        `       Missed:   ${c.spacefold.filesMissed.join(', ')}`
      );
    }
    log(
      `       Baseline: ${c.baseline.totalTokensAllFiles.toLocaleString()} tokens for ${c.baseline.filesNeeded} relevant files ` +
        `(entire codebase: ${c.baseline.totalTokensCodebase.toLocaleString()} tokens across ${c.baseline.totalFilesCodebase} files)`
    );
    log(
      `       Spacefold: ${c.spacefold.tokensUsed.toLocaleString()} tokens (${c.spacefold.chunksReturned} chunks, ${c.spacefold.relevantChunks} relevant)`
    );
    log(
      `       vs codebase: ${fmtSavings(c.savingsVsCodebase)} | Recall: ${c.spacefold.recall.toFixed(2)} | Precision: ${c.spacefold.precision.toFixed(2)}\n`
    );
  }

  // ── Scenario analysis ───────────────────────────────────────────

  log(`${'='.repeat(78)}`);
  log(`  SCENARIO ANALYSIS`);
  log(`${'='.repeat(78)}\n`);

  // Group by recall performance
  const perfectRecall = comparisons.filter(
    (c) => c.spacefold.recall === 1.0
  );
  const partialRecall = comparisons.filter(
    (c) => c.spacefold.recall > 0 && c.spacefold.recall < 1.0
  );
  const zeroRecall = comparisons.filter((c) => c.spacefold.recall === 0);

  log(
    `  Perfect recall (all files found): ${perfectRecall.length} / ${comparisons.length}`
  );
  log(
    `  Partial recall (some files found): ${partialRecall.length} / ${comparisons.length}`
  );
  log(
    `  Zero recall (no files found):      ${zeroRecall.length} / ${comparisons.length}`
  );
  log(
    `  Overall file recall:               ${totalFilesHit}/${totalFilesNeeded} (${((totalFilesHit / totalFilesNeeded) * 100).toFixed(1)}%)\n`
  );

  // Token efficiency
  const withSavings = comparisons.filter((c) => c.savingsVsCodebase > 0);
  const avgSavingsWhenPositive =
    withSavings.length > 0
      ? withSavings.reduce((s, c) => s + c.savingsVsCodebase, 0) / withSavings.length
      : 0;

  const overallCodebaseSavingsAvg =
    totalCodebaseTokens > 0
      ? ((totalCodebaseTokens - totalSfTokens / comparisons.length) / totalCodebaseTokens) * 100
      : 0;

  log(
    `  Token reduction vs entire codebase: ${fmtSavings(overallCodebaseSavingsAvg)} ` +
        `(${totalCodebaseTokens.toLocaleString()} -> ${(totalSfTokens / comparisons.length).toFixed(0)} avg tokens per task)`
  );
  log(
    `  When Spacefold saves tokens (avg of ${withSavings.length} tasks): ${avgSavingsWhenPositive.toFixed(1)}%`
  );
  log(
    `  Average budget utilization: ${((totalSfTokens / (TOKEN_BUDGET * comparisons.length)) * 100).toFixed(1)}%\n`
  );

  // ── Statistical significance (Bootstrap CI) ─────────────────────

  log(`${'='.repeat(78)}`);
  log(`  STATISTICAL SIGNIFICANCE — Bootstrap 95% CI (10,000 resamples)`);
  log(`${'='.repeat(78)}\n`);

  const metricExtractors: {
    key: string;
    label: string;
    extract: (c: TaskComparison) => number;
  }[] = [
    {
      key: 'recall',
      label: 'Recall',
      extract: (c) => c.spacefold.recall,
    },
    {
      key: 'precision',
      label: 'Precision',
      extract: (c) => c.spacefold.precision,
    },
    {
      key: 'savings',
      label: 'Token Savings %',
      extract: (c) => c.savingsVsCodebase,
    },
  ];

  const N_BOOT = 10_000;

  for (const { key, label, extract } of metricExtractors) {
    const values = comparisons.map(extract);
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const std = Math.sqrt(
      values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)
    );

    // Bootstrap
    const bootMeans: number[] = [];
    const rng = createRng(`bootstrap:${key}:${options.strategy}`);
    for (let b = 0; b < N_BOOT; b++) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        sum += values[Math.floor(rng() * n)];
      }
      bootMeans.push(sum / n);
    }
    bootMeans.sort((a, b) => a - b);

    const low = bootMeans[Math.floor(N_BOOT * 0.025)];
    const high = bootMeans[Math.ceil(N_BOOT * 0.975)];

    log(
      `  ${label.padEnd(18)} mean=${mean.toFixed(3)}  95% CI=[${low.toFixed(3)}, ${high.toFixed(3)}]  std=${std.toFixed(3)}`
    );
  }

  // ── Cleanup ─────────────────────────────────────────────────────

  pipeline.close();
  dbArtifact.cleanup();

  const report = buildE2EReport({
    strategy: options.strategy,
    comparisons,
  });

  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    log(`\n${'='.repeat(78)}`);
    log(`  E2E BENCHMARK COMPLETE`);
    log(`  Focused retrieval success gate: ${report.successGate.focusedRetrievalPasses ? 'PASS' : 'FAIL'} ` +
      `(recall>=${report.successGate.recallThreshold}, precision>=${report.successGate.precisionThreshold}, avg tokens<=${report.successGate.averageTokensCeiling})`);
    log(`  Avg token delta vs current hybrid: ${report.summary.averageTokensVsCurrent >= 0 ? `${report.summary.averageTokensVsCurrent.toFixed(0)} fewer` : `${Math.abs(report.summary.averageTokensVsCurrent).toFixed(0)} more`} tokens`);
    log(`  Avg recall delta vs current hybrid: ${report.summary.averageRecallVsCurrent.toFixed(3)}`);
    log(`  Avg precision delta vs current hybrid: ${report.summary.averagePrecisionVsCurrent.toFixed(3)}`);
    log(`  Tasks over full-codebase token count: ${report.summary.tasksReturningMoreThanCodebase.join(', ') || 'none'}`);
    log(`${'='.repeat(78)}\n`);
  }
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  try {
    const e2eOptions = parseArgs(process.argv.slice(2));
    runE2EBenchmark(e2eOptions).catch((err) => {
      console.error(`E2E benchmark failed: ${errorMessage(err)}`);
      process.exit(1);
    });
  } catch (err) {
    console.error(`E2E benchmark failed: ${errorMessage(err)}`);
    process.exit(1);
  }
}
