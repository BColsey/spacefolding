/**
 * Compression Comparison Benchmark
 *
 * Compares Spacefolding's deterministic compression against LLMLingua's
 * token-level compression on the benchmark dataset.
 *
 * Usage:
 *   npx tsx benchmarks/compression-comparison.ts
 *   npx tsx benchmarks/compression-comparison.ts --with-llmlingua
 */

import { readFileSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface BenchmarkTask {
  id: string;
  task: string;
  intent: string;
  relevant_files: string[];
}

interface CompressionResult {
  method: string;
  originalTokens: number;
  compressedTokens: number;
  ratio: number;
  timeMs: number;
  summary: string;
}

export interface CompressionCliOptions {
  withLlmLingua: boolean;
}

export function parseArgs(argv: string[]): CompressionCliOptions {
  const options: CompressionCliOptions = { withLlmLingua: false };

  for (const arg of argv) {
    if (arg === '--with-llmlingua') {
      options.withLlmLingua = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deterministicShuffle<T>(items: T[], seed: string, key: (item: T) => string): T[] {
  return [...items].sort((a, b) =>
    hashString(`${seed}:${key(a)}`) - hashString(`${seed}:${key(b)}`)
  );
}

async function main(options: CompressionCliOptions) {
  const benchDir = dirname(fileURLToPath(import.meta.url));
  const dataset: { tasks: BenchmarkTask[] } = JSON.parse(
    readFileSync(join(benchDir, 'dataset.json'), 'utf-8')
  );
  const withLlmLingua = options.withLlmLingua;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  COMPRESSION COMPARISON BENCHMARK`);
  console.log(`  Tasks: ${dataset.tasks.length}`);
  console.log(`  LLMLingua: ${withLlmLingua ? 'enabled' : 'disabled'}`);
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

  const dbPath = join(benchDir, 'compression-eval.db');
  try { unlinkSync(dbPath); } catch {}

  const storage = createRepository(dbPath);
  const tokenEstimator = new DeterministicTokenEstimator();
  const embeddingProvider = new DeterministicEmbeddingProvider();
  const detCompression = new DeterministicCompressionProvider();

  const pipeline = new PipelineOrchestrator(
    storage,
    new ContextScorer(DEFAULT_ROUTING_CONFIG, embeddingProvider, tokenEstimator),
    new ContextRouter(DEFAULT_ROUTING_CONFIG),
    detCompression,
    new SimpleDependencyAnalyzer(),
    new ContextIngester(tokenEstimator),
    embeddingProvider
  );

  // Ingest source files
  const { readdirSync, readFileSync: readFile, statSync } = await import('node:fs');
  function walkDir(dir: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        if (!['node_modules', '.git', 'dist'].includes(entry)) results.push(...walkDir(fullPath));
      } else if (entry.endsWith('.ts')) results.push(fullPath);
    }
    return results.sort();
  }

  const srcDir = join(benchDir, '..', 'src');
  const files = walkDir(srcDir);
  for (const filePath of files) {
    const content = readFile(filePath, 'utf-8');
    const relativePath = filePath.replace(/.*\/spacefolding\//, '');
    await pipeline.ingest('file', content, undefined, relativePath, undefined);
  }
  console.log(`Ingested ${storage.getAllChunks().length} chunks\n`);

  // Load LLMLingua if requested
  let llmLingua: any = null;
  if (withLlmLingua) {
    try {
      const { LlmLinguaCompressionProvider } = await import('../dist/providers/llmlingua-compression.js');
      llmLingua = new LlmLinguaCompressionProvider();
      console.log('LLMLingua provider loaded\n');
    } catch (e) {
      console.log(`LLMLingua not available: ${e}\n`);
    }
  }

  // Compression methods to compare
  const methods: Array<{
    name: string;
    compress: (task: string, texts: string[]) => Promise<{ summary: string; tokens: number }>;
  }> = [
    {
      name: 'deterministic',
      compress: async (task, texts) => {
        const start = performance.now();
        const chunks = texts.map((t, i) => ({
          id: `c${i}`,
          source: 'test',
          type: 'code' as const,
          text: t,
          timestamp: Date.now(),
          tokensEstimate: Math.ceil(t.split(/\s+/).length * 1.3),
          childrenIds: [],
          metadata: {},
        }));
        const result = await detCompression.compress({ text: task }, chunks);
        const timeMs = performance.now() - start;
        return {
          summary: result.summary,
          tokens: Math.ceil(result.summary.split(/\s+/).length * 1.3),
          timeMs,
        };
      },
    },
  ];

  if (llmLingua) {
    methods.push({
      name: 'llmlingua',
      compress: async (task, texts) => {
        const start = performance.now();
        const chunks = texts.map((t, i) => ({
          id: `c${i}`,
          source: 'test',
          type: 'code' as const,
          text: t,
          timestamp: Date.now(),
          tokensEstimate: Math.ceil(t.split(/\s+/).length * 1.3),
          childrenIds: [],
          metadata: {},
        }));
        const result = await llmLingua.compress({ text: task }, chunks);
        const timeMs = performance.now() - start;
        return {
          summary: result.summary,
          tokens: result.summary.split(/\s+/).length,
          timeMs,
        };
      },
    });
  }

  // Run comparison
  const allResults: Record<string, CompressionResult[]> = {};
  for (const method of methods) {
    allResults[method.name] = [];
  }

  // Pick 10 tasks for compression evaluation
  const evalTasks = dataset.tasks.slice(0, 10);
  const allChunks = storage.getAllChunks();

  for (const task of evalTasks) {
    console.log(`Task: ${task.task.slice(0, 60)}...`);

    // Pick 3 random chunks to compress (simulate overflow)
    const sampleChunks = deterministicShuffle(
      allChunks,
      `compression:${task.id}`,
      (chunk) => `${chunk.path ?? ''}:${chunk.id}`
    ).slice(0, 3);

    const originalTexts = sampleChunks.map(c => c.text);
    const originalTokens = originalTexts.reduce((s, t) => s + Math.ceil(t.split(/\s+/).length * 1.3), 0);

    for (const method of methods) {
      const start = performance.now();
      try {
        const result = await method.compress(task.task, originalTexts);
        const timeMs = performance.now() - start;
        const ratio = result.tokens / originalTokens;

        allResults[method.name].push({
          method: method.name,
          originalTokens,
          compressedTokens: result.tokens,
          ratio,
          timeMs,
          summary: result.summary.slice(0, 80),
        });

        console.log(`  ${method.name}: ${originalTokens} → ${result.tokens} tokens (${(ratio * 100).toFixed(1)}%) in ${timeMs.toFixed(0)}ms`);
      } catch (e) {
        console.log(`  ${method.name}: FAILED (${e})`);
      }
    }
    console.log();
  }

  // Summary
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  COMPRESSION COMPARISON SUMMARY`);
  console.log(`${'═'.repeat(70)}\n`);

  console.log(`${'Method'.padEnd(20)} ${'Avg Ratio'.padEnd(12)} ${'Avg Time'.padEnd(12)} ${'Avg Tokens'.padEnd(12)}`);
  console.log(`${'─'.repeat(56)}`);

  for (const method of methods) {
    const results = allResults[method.name];
    if (results.length === 0) continue;

    const avgRatio = results.reduce((s, r) => s + r.ratio, 0) / results.length;
    const avgTime = results.reduce((s, r) => s + r.timeMs, 0) / results.length;
    const avgTokens = results.reduce((s, r) => s + r.compressedTokens, 0) / results.length;

    console.log(`${method.name.padEnd(20)} ${(avgRatio * 100).toFixed(1).padEnd(11)}% ${avgTime.toFixed(0).padEnd(11)}ms ${avgTokens.toFixed(0).padEnd(11)}`);
  }

  // Cleanup
  pipeline.close();
  if (llmLingua?.close) llmLingua.close();
  try { unlinkSync(dbPath); } catch {}
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    main(options).catch((err) => {
      console.error(`Compression comparison failed: ${errorMessage(err)}`);
      process.exit(1);
    });
  } catch (error) {
    console.error(`Compression comparison failed: ${errorMessage(error)}`);
    process.exit(1);
  }
}
