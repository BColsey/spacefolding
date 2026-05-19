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

import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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

interface RetrievalResult {
  chunkId: string;
  filePath: string | undefined;
  score: number;
  rank: number;
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
  mrr: number; // Mean Reciprocal Rank
  avgResults: number;
}

interface EvalResult {
  taskId: string;
  task: string;
  intent: string;
  metrics: Metrics;
  details: {
    retrievedPaths: string[];
    relevantPaths: string[];
    hits: string[];
    misses: string[];
  };
}

interface CliOptions {
  dataset: string;
  corpus: string;
  strategy: string;
  json: boolean;
}

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

function parseArgs(argv: string[], benchDir: string): CliOptions {
  const options: CliOptions = {
    dataset: join(benchDir, 'dataset.json'),
    corpus: join(benchDir, '..', 'src'),
    strategy: 'all',
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dataset' && argv[i + 1]) options.dataset = argv[++i];
    else if (arg === '--corpus' && argv[i + 1]) options.corpus = argv[++i];
    else if (arg === '--strategy' && argv[i + 1]) options.strategy = argv[++i];
    else if (arg === '--json') options.json = true;
    else if (!arg.startsWith('--')) options.strategy = arg;
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
    topK: 50,
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

// ── Main Evaluation Runner ──────────────────────────────────

async function runEvaluation(options: CliOptions) {
  const benchDir = dirname(fileURLToPath(import.meta.url));
  const dataset: BenchmarkDataset = JSON.parse(
    readFileSync(options.dataset, 'utf-8')
  );
  const log = (...args: unknown[]) => {
    if (!options.json) console.log(...args);
  };

  log(`\n${'═'.repeat(70)}`);
  log(`  SPACEFOLDING RETRIEVAL BENCHMARK`);
  log(`  Tasks: ${dataset.tasks.length} | Strategy: ${options.strategy}`);
  log(`  Dataset: ${relative(benchDir, options.dataset) || options.dataset}`);
  log(`  Corpus: ${relative(benchDir, options.corpus) || options.corpus}`);
  log(`${'═'.repeat(70)}\n`);

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
  const dbPath = join(benchDir, 'benchmark-eval.db');
  try { unlinkSync(dbPath); } catch {}

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
  const files = walkDir(options.corpus);
  log(`Ingesting ${files.length} source files...`);

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const relativePath = relative(projectRoot, filePath);
    await pipeline.ingest('file', content, undefined, relativePath, undefined);
  }

  const allChunks = storage.getAllChunks();
  log(`Ingested ${allChunks.length} chunks\n`);

  // Run evaluations for each strategy
  const strategies = options.strategy === 'all'
    ? ['keyword', 'path-match', 'fts', 'vector', 'symbol-only', 'structural']
    : [options.strategy];

  const summaries: Array<{
    strategy: string;
    averages: Record<string, number>;
    results: EvalResult[];
  }> = [];

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
    const avgMetrics: Record<string, number> = {};
    const metricKeys = Object.keys(results[0].metrics) as (keyof Metrics)[];
    for (const key of metricKeys) {
      const sum = results.reduce((s, r) => s + r.metrics[key], 0);
      avgMetrics[key] = sum / results.length;
    }

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
  try { unlinkSync(dbPath); } catch {}

  const byStrategy = Object.fromEntries(summaries.map((summary) => [summary.strategy, summary]));
  const keyword = byStrategy.keyword;
  const structural = byStrategy.structural;
  const beatsKeyword = Boolean(keyword && structural
    && structural.averages.recallAt10 > keyword.averages.recallAt10
    && structural.averages.ndcgAt10 > keyword.averages.ndcgAt10
    && structural.averages.mrr > keyword.averages.mrr);

  if (options.json) {
    console.log(JSON.stringify({
      dataset: options.dataset,
      corpus: options.corpus,
      strategies: summaries,
      successGate: {
        structuralBeatsKeyword: beatsKeyword,
        recallAt10Delta: structural && keyword ? structural.averages.recallAt10 - keyword.averages.recallAt10 : null,
        ndcgAt10Delta: structural && keyword ? structural.averages.ndcgAt10 - keyword.averages.ndcgAt10 : null,
        mrrDelta: structural && keyword ? structural.averages.mrr - keyword.averages.mrr : null,
      },
    }, null, 2));
  } else {
    log(`\n${'═'.repeat(70)}`);
    log(`  BENCHMARK COMPLETE`);
    if (keyword && structural) {
      log(`  Structural beats keyword on strict metrics: ${beatsKeyword ? 'yes' : 'no'}`);
    }
    log(`${'═'.repeat(70)}\n`);
  }
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry !== 'node_modules' && entry !== '.git' && entry !== 'dist') {
        results.push(...walkDir(fullPath));
      }
    } else {
      if (['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java'].includes(extname(entry))) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

// Run
const benchDir = dirname(fileURLToPath(import.meta.url));
const options = parseArgs(process.argv.slice(2), benchDir);
runEvaluation(options).catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
