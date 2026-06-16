/**
 * WS0.3 fusion-weight calibration sweep.
 *
 * The commit-derived GPU benchmark (COMMIT-DERIVED-FINDINGS.md) found that with
 * real code embeddings the standalone `vector` arm is strong, yet the fused
 * `structural` strategy drops BELOW max(vector, fts) — a miscalibrated fusion.
 * This harness re-calibrates the WS0.3 weighted-RRF weights (and the vector
 * relevance floor) WITHOUT re-embedding the corpus per config:
 *
 *   1. Ingest the corpus ONCE with the configured embedding provider.
 *   2. Cache query embeddings (so re-running retrieval per config is CPU-bound).
 *   3. For each (w_structural, w_vector, w_fts, vector_floor) config, set the
 *      in-process override hooks on the REAL retriever (setFusionWeightsOverride
 *      / setVectorFloorOverride) and re-run the actual `pipeline.retrieve` path
 *      used by evaluate.ts — so the sweep metric == the confirmatory metric.
 *
 * Overfitting guard: each task is assigned to a calibration or holdout split by
 * a deterministic interleave; per-config aggregates are reported on all / calib
 * / holdout so a winning config can be picked on calibration and validated on
 * holdout, and across repos.
 *
 * Usage:
 *   BENCH_EMBEDDING=gpu npx tsx benchmarks/fusion-sweep.ts \
 *     --dataset /tmp/sf-commit-django.json --corpus corpora/django \
 *     --out /tmp/sf-sweep-django.json
 */

import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EmbeddingProvider, RetrievalStrategy } from '../src/types/index.js';
import { loadBenchmarkDataset, walkDir } from './evaluate.js';
import { projectRelativePath } from './source-files.js';
import { createBenchmarkSqliteArtifact } from './temp-artifacts.js';

// ── Sweep grid (edit here) ───────────────────────────────────
// Weights for the `structural` strategy when the vector arm is reliable (GPU).
// dependency/graph are held at their production small values.
// SWEEP_QUICK=1 runs a tiny grid for plumbing/override smoke tests.
// SWEEP_S / SWEEP_V / SWEEP_F / SWEEP_FLOOR (comma lists) override each axis.
const QUICK = process.env.SWEEP_QUICK === '1';
const parseList = (env: string | undefined, fallback: number[]): number[] =>
  env ? env.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)) : fallback;
const W_STRUCTURAL = QUICK ? [0, 0.3] : parseList(process.env.SWEEP_S, [0, 0.15, 0.3, 0.45]);
const W_VECTOR = QUICK ? [0.55] : parseList(process.env.SWEEP_V, [0.25, 0.4, 0.55, 0.7]);
const W_FTS = QUICK ? [0.4] : parseList(process.env.SWEEP_F, [0.25, 0.4, 0.55, 0.7]);
const VECTOR_FLOORS = QUICK ? [0.2] : parseList(process.env.SWEEP_FLOOR, [0.2, 0.3, 0.4]);
const DEPENDENCY_W = 0.03;
const GRAPH_W = 0;

interface SweepTask {
  id: string;
  task: string;
  intent: string;
  relevant_files: string[];
}

interface TaskMetrics {
  recallAt5: number;
  recallAt10: number;
  recallAt20: number;
  ndcgAt10: number;
  mrr: number;
  hitsAt1: number;
  hitsAt5: number;
}

interface ConfigResult {
  label: string;
  weights: { structural: number; vector: number; fts: number; dependency: number; graph: number };
  vectorFloor: number;
  all: TaskMetrics;
  calib: TaskMetrics;
  holdout: TaskMetrics;
}

// ── Metrics (mirrors evaluate.ts computeMetrics) ─────────────

function computeTaskMetrics(retrieved: string[], relevant: Set<string>, totalRelevant: number): TaskMetrics {
  const recallAt = (k: number) => {
    if (totalRelevant === 0) return 0;
    const hits = retrieved.slice(0, k).filter((p) => relevant.has(p)).length;
    return hits / totalRelevant;
  };
  const ndcgAt = (k: number) => {
    const topK = retrieved.slice(0, k);
    let dcg = 0;
    for (let i = 0; i < topK.length; i++) {
      dcg += (relevant.has(topK[i]) ? 1 : 0) / Math.log2(i + 2);
    }
    let idcg = 0;
    const idealCount = Math.min(totalRelevant, k);
    for (let i = 0; i < idealCount; i++) idcg += 1 / Math.log2(i + 2);
    return idcg > 0 ? dcg / idcg : 0;
  };
  const mrr = (() => {
    for (let i = 0; i < retrieved.length; i++) {
      if (relevant.has(retrieved[i])) return 1 / (i + 1);
    }
    return 0;
  })();
  const hitsAt = (k: number) => (retrieved.slice(0, k).some((p) => relevant.has(p)) ? 1 : 0);
  return {
    recallAt5: recallAt(5),
    recallAt10: recallAt(10),
    recallAt20: recallAt(20),
    ndcgAt10: ndcgAt(10),
    mrr,
    hitsAt1: hitsAt(1),
    hitsAt5: hitsAt(5),
  };
}

function meanMetrics(perTask: TaskMetrics[]): TaskMetrics {
  const n = perTask.length || 1;
  const sum = (k: keyof TaskMetrics) => perTask.reduce((s, m) => s + m[k], 0) / n;
  return {
    recallAt5: sum('recallAt5'),
    recallAt10: sum('recallAt10'),
    recallAt20: sum('recallAt20'),
    ndcgAt10: sum('ndcgAt10'),
    mrr: sum('mrr'),
    hitsAt1: sum('hitsAt1'),
    hitsAt5: sum('hitsAt5'),
  };
}

// ── Embedding provider (mirrors evaluate.ts, plus a query cache) ──

async function createSweepEmbeddingProvider(): Promise<EmbeddingProvider> {
  const mode = (process.env.BENCH_EMBEDDING ?? 'deterministic').toLowerCase();
  let base: EmbeddingProvider;
  if (mode === 'gpu') {
    const { GpuEmbeddingProvider } = await import('../dist/providers/gpu-embedding.js');
    base = new GpuEmbeddingProvider();
  } else if (mode === 'local') {
    const { LocalEmbeddingProvider } = await import('../dist/providers/local-embedding.js');
    base = new LocalEmbeddingProvider(process.env.EMBEDDING_MODEL);
  } else {
    const { DeterministicEmbeddingProvider } = await import('../dist/providers/deterministic-embedding.js');
    base = new DeterministicEmbeddingProvider();
  }
  // Memoize single-text embeds (the query path) so re-running retrieval across
  // hundreds of weight configs does not re-hit the GPU for identical queries.
  const cache = new Map<string, Promise<number[]>>();
  return {
    quality: base.quality,
    embed(text: string) {
      let p = cache.get(text);
      if (!p) {
        p = base.embed(text);
        cache.set(text, p);
      }
      return p;
    },
    embedBatch: (texts: string[]) => base.embedBatch(texts),
    close: () => (base as { close?: () => void }).close?.(),
  } as EmbeddingProvider;
}

async function buildRuntime(dbPath: string, embeddingProvider: EmbeddingProvider) {
  const { createRepository } = await import('../dist/storage/repository.js');
  const { DeterministicTokenEstimator } = await import('../dist/providers/token-estimator.js');
  const { DeterministicCompressionProvider } = await import('../dist/providers/deterministic-compression.js');
  const { SimpleDependencyAnalyzer } = await import('../dist/providers/dependency-analyzer.js');
  const { ContextScorer } = await import('../dist/core/scorer.js');
  const { ContextRouter, DEFAULT_ROUTING_CONFIG } = await import('../dist/core/router.js');
  const { ContextIngester } = await import('../dist/core/ingester.js');
  const { PipelineOrchestrator } = await import('../dist/pipeline/orchestrator.js');

  const storage = createRepository(dbPath);
  const tokenEstimator = new DeterministicTokenEstimator();
  const compressionProvider = new DeterministicCompressionProvider();
  const dependencyAnalyzer = new SimpleDependencyAnalyzer();
  const scorer = new ContextScorer(DEFAULT_ROUTING_CONFIG, embeddingProvider, tokenEstimator);
  const router = new ContextRouter(DEFAULT_ROUTING_CONFIG);
  const ingester = new ContextIngester(tokenEstimator);
  const pipeline = new PipelineOrchestrator(
    storage, scorer, router, compressionProvider, dependencyAnalyzer, ingester, embeddingProvider
  );
  return { storage, pipeline, close: () => pipeline.close() };
}

async function retrievePaths(pipeline: any, query: string, strategy: RetrievalStrategy): Promise<string[]> {
  const result = await pipeline.retrieve(query, 200_000, {
    strategy,
    mode: 'exhaustive',
    topK: 50,
    returnLimit: 50,
    maxHops: 0,
  });
  const paths = result.chunks.map((c: any) => c.path).filter(Boolean) as string[];
  return [...new Set(paths)];
}

async function evalStrategy(
  pipeline: any,
  tasks: SweepTask[],
  strategy: RetrievalStrategy
): Promise<TaskMetrics[]> {
  const out: TaskMetrics[] = [];
  for (const task of tasks) {
    const retrieved = await retrievePaths(pipeline, task.task, strategy);
    out.push(computeTaskMetrics(retrieved, new Set(task.relevant_files), task.relevant_files.length));
  }
  return out;
}

function subset(perTask: TaskMetrics[], indices: number[]): TaskMetrics[] {
  return indices.map((i) => perTask[i]);
}

function parseSweepArgs(argv: string[], benchDir: string) {
  const opts = {
    dataset: join(benchDir, 'dataset.json'),
    corpus: join(benchDir, '..'),
    out: '/tmp/sf-fusion-sweep.json',
    includeTests: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dataset') opts.dataset = argv[++i];
    else if (a === '--corpus') opts.corpus = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--include-tests') opts.includeTests = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

async function main() {
  const benchDir = dirname(fileURLToPath(import.meta.url));
  const opts = parseSweepArgs(process.argv.slice(2), benchDir);
  const { setFusionWeightsOverride, setVectorFloorOverride } = await import('../dist/core/retriever.js');

  const dataset = loadBenchmarkDataset(opts.dataset);
  const tasks: SweepTask[] = dataset.tasks.map((t) => ({
    id: t.id, task: t.task, intent: t.intent, relevant_files: t.relevant_files,
  }));
  // Deterministic interleave split: even index -> calibration, odd -> holdout.
  const calibIdx = tasks.map((_, i) => i).filter((i) => i % 2 === 0);
  const holdoutIdx = tasks.map((_, i) => i).filter((i) => i % 2 === 1);

  const embeddingProvider = await createSweepEmbeddingProvider();
  const dbArtifact = createBenchmarkSqliteArtifact('fusion-sweep');
  const runtime = await buildRuntime(dbArtifact.path, embeddingProvider);

  const projectRoot = join(benchDir, '..');
  const files = walkDir(opts.corpus, opts.includeTests);
  process.stderr.write(`[sweep] ingesting ${files.length} files (embedding=${process.env.BENCH_EMBEDDING ?? 'deterministic'})...\n`);
  const t0 = Date.now();
  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const rel = projectRelativePath(projectRoot, filePath);
    await runtime.pipeline.ingest('file', content, undefined, rel, undefined);
  }
  process.stderr.write(`[sweep] ingest done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // Baselines (no override): pure vector and pure fts (= text), plus the
  // default `hybrid` (vector+fts) and `structural` strategies for reference.
  setFusionWeightsOverride(null);
  setVectorFloorOverride(null);
  process.stderr.write('[sweep] baselines: vector, fts, hybrid(default), structural(default)...\n');
  const vectorPer = await evalStrategy(runtime.pipeline, tasks, 'vector');
  const ftsPer = await evalStrategy(runtime.pipeline, tasks, 'text');
  const hybridDefaultPer = await evalStrategy(runtime.pipeline, tasks, 'hybrid');
  const structDefaultPer = await evalStrategy(runtime.pipeline, tasks, 'structural');

  const baselines = {
    vector: { all: meanMetrics(vectorPer), calib: meanMetrics(subset(vectorPer, calibIdx)), holdout: meanMetrics(subset(vectorPer, holdoutIdx)) },
    fts: { all: meanMetrics(ftsPer), calib: meanMetrics(subset(ftsPer, calibIdx)), holdout: meanMetrics(subset(ftsPer, holdoutIdx)) },
    hybridDefault: { all: meanMetrics(hybridDefaultPer), calib: meanMetrics(subset(hybridDefaultPer, calibIdx)), holdout: meanMetrics(subset(hybridDefaultPer, holdoutIdx)) },
    structuralDefault: { all: meanMetrics(structDefaultPer), calib: meanMetrics(subset(structDefaultPer, calibIdx)), holdout: meanMetrics(subset(structDefaultPer, holdoutIdx)) },
  };
  process.stderr.write(
    `[sweep] baselines R@10  vector=${baselines.vector.all.recallAt10.toFixed(3)} ` +
    `fts=${baselines.fts.all.recallAt10.toFixed(3)} ` +
    `hybrid(def)=${baselines.hybridDefault.all.recallAt10.toFixed(3)} ` +
    `structural(def)=${baselines.structuralDefault.all.recallAt10.toFixed(3)}\n`
  );

  // Build the config grid.
  const configs: { structural: number; vector: number; fts: number; floor: number }[] = [];
  for (const s of W_STRUCTURAL) {
    for (const v of W_VECTOR) {
      for (const f of W_FTS) {
        for (const floor of VECTOR_FLOORS) {
          configs.push({ structural: s, vector: v, fts: f, floor });
        }
      }
    }
  }
  process.stderr.write(`[sweep] ${configs.length} structural-strategy configs to evaluate...\n`);

  const results: ConfigResult[] = [];
  let done = 0;
  for (const c of configs) {
    const weights = { structural: c.structural, vector: c.vector, fts: c.fts, dependency: DEPENDENCY_W, graph: GRAPH_W };
    setFusionWeightsOverride({ 'structural:reliable': weights });
    setVectorFloorOverride(c.floor);
    const per = await evalStrategy(runtime.pipeline, tasks, 'structural');
    const label = `s${c.structural}_v${c.vector}_f${c.fts}_fl${c.floor}`;
    results.push({
      label,
      weights,
      vectorFloor: c.floor,
      all: meanMetrics(per),
      calib: meanMetrics(subset(per, calibIdx)),
      holdout: meanMetrics(subset(per, holdoutIdx)),
    });
    done++;
    if (done % 10 === 0 || done === configs.length) {
      const best = [...results].sort((a, b) => b.all.recallAt10 - a.all.recallAt10)[0];
      process.stderr.write(`[sweep] ${done}/${configs.length}  best-so-far R@10(all)=${best.all.recallAt10.toFixed(3)} [${best.label}]\n`);
    }
  }

  setFusionWeightsOverride(null);
  setVectorFloorOverride(null);
  runtime.close();
  (embeddingProvider as { close?: () => void }).close?.();
  dbArtifact.cleanup();

  const report = {
    repo: relative(projectRoot, opts.corpus) || opts.corpus,
    dataset: opts.dataset,
    nTasks: tasks.length,
    calibCount: calibIdx.length,
    holdoutCount: holdoutIdx.length,
    embedding: process.env.BENCH_EMBEDDING ?? 'deterministic',
    baselines,
    grid: { W_STRUCTURAL, W_VECTOR, W_FTS, VECTOR_FLOORS, DEPENDENCY_W, GRAPH_W },
    configs: results,
  };
  writeFileSync(opts.out, JSON.stringify(report, null, 2));
  process.stderr.write(`[sweep] wrote ${opts.out}\n`);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`fusion-sweep failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
