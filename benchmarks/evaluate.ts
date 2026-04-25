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
import { join, dirname, extname } from 'node:path';
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
  _task: BenchmarkTask,
  allChunks: { id: string; text: string; path?: string }[]
): Promise<string[]> {
  const shuffled = [...allChunks].sort(() => Math.random() - 0.5);
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
  pipeline: any
): Promise<string[]> {
  const result = await pipeline.retrieve(task.task, 200_000, {
    strategy: 'hybrid',
    topK: 50,
    maxHops: 2,
  });

  return result.chunks.map((c: any) => c.path).filter(Boolean);
}

// ── Main Evaluation Runner ──────────────────────────────────

async function runEvaluation(strategy: string = 'all') {
  const benchDir = dirname(fileURLToPath(import.meta.url));
  const dataset: BenchmarkDataset = JSON.parse(
    readFileSync(join(benchDir, 'dataset.json'), 'utf-8')
  );

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  SPACEFOLDING RETRIEVAL BENCHMARK`);
  console.log(`  Tasks: ${dataset.tasks.length} | Strategy: ${strategy}`);
  console.log(`${'═'.repeat(70)}\n`);

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
  const srcDir = join(benchDir, '..', 'src');
  const files = walkDir(srcDir);
  console.log(`Ingesting ${files.length} source files...`);

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const relativePath = filePath.replace(/.*\/spacefolding\//, '');
    await pipeline.ingest('file', content, undefined, relativePath, undefined);
  }

  const allChunks = storage.getAllChunks();
  console.log(`Ingested ${allChunks.length} chunks\n`);

  // Run evaluations for each strategy
  const strategies = strategy === 'all'
    ? ['spacefolding', 'keyword', 'path-match', 'random']
    : [strategy];

  for (const strat of strategies) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`  Strategy: ${strat.toUpperCase()}`);
    console.log(`${'─'.repeat(70)}\n`);

    const results: EvalResult[] = [];

    for (const task of dataset.tasks) {
      const relevantSet = new Set(task.relevant_files);
      let retrievedPaths: string[];

      switch (strat) {
        case 'spacefolding':
          retrievedPaths = await spacefoldingRetrieval(task, pipeline);
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
      console.log(
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
    console.log(`\n  ${'─'.repeat(50)}`);
    console.log(`  AVERAGE (${results.length} tasks)`);
    console.log(`  ${'─'.repeat(50)}`);
    console.log(`  Recall@5:       ${avgMetrics.recallAt5.toFixed(3)}`);
    console.log(`  Recall@10:      ${avgMetrics.recallAt10.toFixed(3)}`);
    console.log(`  Recall@20:      ${avgMetrics.recallAt20.toFixed(3)}`);
    console.log(`  Precision@5:    ${avgMetrics.precisionAt5.toFixed(3)}`);
    console.log(`  Precision@10:   ${avgMetrics.precisionAt10.toFixed(3)}`);
    console.log(`  Precision@20:   ${avgMetrics.precisionAt20.toFixed(3)}`);
    console.log(`  NDCG@10:        ${avgMetrics.ndcgAt10.toFixed(3)}`);
    console.log(`  NDCG@20:        ${avgMetrics.ndcgAt20.toFixed(3)}`);
    console.log(`  MRR:            ${avgMetrics.mrr.toFixed(3)}`);
    console.log(`  Avg results:    ${avgMetrics.avgResults.toFixed(1)}`);

    // Breakdown by intent
    const intents = [...new Set(results.map((r) => r.intent))];
    console.log(`\n  By intent:`);
    for (const intent of intents) {
      const intentResults = results.filter((r) => r.intent === intent);
      const avgRecall = intentResults.reduce((s, r) => s + r.metrics.recallAt10, 0) / intentResults.length;
      const avgNdcg = intentResults.reduce((s, r) => s + r.metrics.ndcgAt10, 0) / intentResults.length;
      console.log(`    ${intent.padEnd(12)} R@10=${avgRecall.toFixed(3)} NDCG=${avgNdcg.toFixed(3)} (${intentResults.length} tasks)`);
    }
  }

  // Cleanup
  pipeline.close();
  try { unlinkSync(dbPath); } catch {}

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  BENCHMARK COMPLETE`);
  console.log(`${'═'.repeat(70)}\n`);
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
      if (extname(entry) === '.ts') {
        results.push(fullPath);
      }
    }
  }
  return results;
}

// Run
const strategy = process.argv[2] ?? 'all';
runEvaluation(strategy).catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
