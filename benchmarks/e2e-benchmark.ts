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

import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Types ────────────────────────────────────────────────────────

interface E2ETask {
  id: string;
  name: string;
  description: string;
  /** Files a developer would need to read to complete the task */
  expectedFiles: string[];
  /** Brief description of what the task entails */
  expectedChanges: string;
}

interface BaselineResult {
  filesNeeded: number;
  /** Sum of tokens across all expected files (entire file contents) */
  totalTokensAllFiles: number;
  /** Tokens to read the entire codebase (what you'd need without retrieval) */
  totalTokensCodebase: number;
  /** Total number of files in the codebase */
  totalFilesCodebase: number;
}

interface SpacefoldResult {
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
}

interface TaskComparison {
  task: E2ETask;
  baseline: BaselineResult;
  spacefold: SpacefoldResult;
  /** % token savings vs reading only the expected files */
  savingsVsRelevant: number;
  /** % token savings vs reading the entire codebase */
  savingsVsCodebase: number;
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
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (!['node_modules', '.git', 'dist'].includes(entry))
        results.push(...walkDir(fullPath));
    } else if (extname(entry) === '.ts') {
      results.push(fullPath);
    }
  }
  return results;
}

/** Estimate tokens for a string (rough: words * 1.3) */
function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.3);
}

/** Format savings percentage: positive = less tokens used (good) */
function fmtSavings(v: number): string {
  return v >= 0 ? `${v.toFixed(0)}% saved` : `+${Math.abs(v).toFixed(0)}% more`;
}

// ── Main ─────────────────────────────────────────────────────────

async function runE2EBenchmark() {
  const benchDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(benchDir, '..');

  console.log(`\n${'='.repeat(78)}`);
  console.log(`  END-TO-END A/B BENCHMARK`);
  console.log(`  Tasks: ${TASKS.length}`);
  console.log(`  Measures: file recall, token efficiency, precision`);
  console.log(`${'='.repeat(78)}\n`);

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

  const dbPath = join(benchDir, 'e2e-benchmark.db');
  try {
    unlinkSync(dbPath);
  } catch {}

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

  // ── Ingest source files ─────────────────────────────────────────

  const srcDir = join(projectRoot, 'src');
  const files = walkDir(srcDir);
  console.log(`Ingesting ${files.length} source files...`);

  // Build a map of relative path -> file content for baseline calculation
  const fileContents = new Map<string, string>();

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const relativePath = relative(projectRoot, filePath);
    fileContents.set(relativePath, content);
    await pipeline.ingest('file', content, undefined, relativePath, undefined);
  }

  const allChunks = storage.getAllChunks();
  console.log(`Ingested ${allChunks.length} chunks\n`);

  // Build path -> chunks lookup for precision measurement
  const chunksByPath = new Map<string, typeof allChunks>();
  for (const chunk of allChunks) {
    if (chunk.path) {
      const list = chunksByPath.get(chunk.path) ?? [];
      list.push(chunk);
      chunksByPath.set(chunk.path, list);
    }
  }

  // Compute total codebase tokens for baseline comparison
  const totalCodebaseTokens = [...fileContents.values()].reduce(
    (sum, content) => sum + estimateTokens(content),
    0
  );
  const totalCodebaseFiles = fileContents.size;

  // ── Run comparison ──────────────────────────────────────────────

  const comparisons: TaskComparison[] = [];

  const TOKEN_BUDGET = 50_000; // Realistic budget for a coding task

  for (const task of TASKS) {
    console.log(
      `${'─'.repeat(78)}\n  Task ${task.id}: ${task.name}\n${'─'.repeat(78)}`
    );
    console.log(`  "${task.description.slice(0, 90)}..."`);
    console.log(
      `  Expected files: ${task.expectedFiles.join(', ')}\n`
    );

    // ── Baseline: read all expected files ──────────────────────────

    let baselineTotalTokens = 0;
    let filesFound = 0;
    for (const expectedPath of task.expectedFiles) {
      const content = fileContents.get(expectedPath);
      if (content) {
        baselineTotalTokens += estimateTokens(content);
        filesFound++;
      }
    }

    const baseline: BaselineResult = {
      filesNeeded: task.expectedFiles.length,
      totalTokensAllFiles: baselineTotalTokens,
      totalTokensCodebase: totalCodebaseTokens,
      totalFilesCodebase: totalCodebaseFiles,
    };

    console.log(
      `  BASELINE: ${baseline.filesNeeded} relevant files (${baseline.totalTokensAllFiles.toLocaleString()} tokens), ` +
        `entire codebase: ${totalCodebaseFiles} files (${totalCodebaseTokens.toLocaleString()} tokens)`
    );

    // ── Spacefolding: retrieve with the task description ───────────

    const retrievalResult = await pipeline.retrieve(
      task.description,
      TOKEN_BUDGET,
      {
        strategy: 'hybrid',
        topK: 15,
        maxHops: 2,
      }
    );

    const returnedPaths = new Set(
      retrievalResult.chunks
        .map((c: any) => c.path)
        .filter(Boolean) as string[]
    );
    const expectedSet = new Set(task.expectedFiles);

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

    console.log(
      `  SPACEFOLD: ${filesHit.length}/${task.expectedFiles.length} files found, ` +
        `${spacefold.tokensUsed.toLocaleString()} tokens used / ${spacefold.tokensBudget.toLocaleString()} budget ` +
        `(${(spacefold.utilization * 100).toFixed(1)}% util)`
    );
    console.log(
      `            recall=${recall.toFixed(2)} precision=${precision.toFixed(2)} ` +
        `${spacefold.chunksReturned} chunks (${spacefold.relevantChunks} relevant)`
    );
    console.log(
      `            vs codebase: ${fmtSavings(savingsVsCodebase)}`
    );
    if (filesMissed.length > 0) {
      console.log(`            missed: ${filesMissed.join(', ')}`);
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

  console.log(`\n\n${'='.repeat(78)}`);
  console.log(`  COMPARISON TABLE`);
  console.log(`${'='.repeat(78)}\n`);

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
  console.log(`  ${hdr}`);
  console.log(`  ${'─'.repeat(hdr.length)}`);

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
    console.log(`  ${row}`);

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

  console.log(`  ${'─'.repeat(hdr.length)}`);
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
  console.log(`  ${avgRow}`);
  console.log(`\n  Note: "vs Codebase" shows token savings compared to reading all ${totalCodebaseFiles} files (${totalCodebaseTokens.toLocaleString()} tokens)`);
  console.log(`        Positive savings = Spacefold uses fewer tokens; "+X% more" = Spacefold uses more tokens`);
  console.log(`        With deterministic (hash-based) embeddings, results approximate random retrieval.`);
  console.log(`        Real embeddings significantly improve recall and precision.`);

  // ── Per-task detail ──────────────────────────────────────────────

  console.log(`\n\n${'='.repeat(78)}`);
  console.log(`  PER-TASK DETAIL`);
  console.log(`${'='.repeat(78)}\n`);

  for (const c of comparisons) {
    const icon = c.spacefold.filesMissed.length === 0 ? 'OK' : 'MISS';
    console.log(`  [${icon}] ${c.task.id}: ${c.task.name}`);
    console.log(`       Expected: ${c.task.expectedFiles.join(', ')}`);
    console.log(`       Found:    ${c.spacefold.filesFound.join(', ') || '(none)'}`);
    if (c.spacefold.filesMissed.length > 0) {
      console.log(
        `       Missed:   ${c.spacefold.filesMissed.join(', ')}`
      );
    }
    console.log(
      `       Baseline: ${c.baseline.totalTokensAllFiles.toLocaleString()} tokens for ${c.baseline.filesNeeded} relevant files ` +
        `(entire codebase: ${c.baseline.totalTokensCodebase.toLocaleString()} tokens across ${c.baseline.totalFilesCodebase} files)`
    );
    console.log(
      `       Spacefold: ${c.spacefold.tokensUsed.toLocaleString()} tokens (${c.spacefold.chunksReturned} chunks, ${c.spacefold.relevantChunks} relevant)`
    );
    console.log(
      `       vs codebase: ${fmtSavings(c.savingsVsCodebase)} | Recall: ${c.spacefold.recall.toFixed(2)} | Precision: ${c.spacefold.precision.toFixed(2)}\n`
    );
  }

  // ── Scenario analysis ───────────────────────────────────────────

  console.log(`${'='.repeat(78)}`);
  console.log(`  SCENARIO ANALYSIS`);
  console.log(`${'='.repeat(78)}\n`);

  // Group by recall performance
  const perfectRecall = comparisons.filter(
    (c) => c.spacefold.recall === 1.0
  );
  const partialRecall = comparisons.filter(
    (c) => c.spacefold.recall > 0 && c.spacefold.recall < 1.0
  );
  const zeroRecall = comparisons.filter((c) => c.spacefold.recall === 0);

  console.log(
    `  Perfect recall (all files found): ${perfectRecall.length} / ${comparisons.length}`
  );
  console.log(
    `  Partial recall (some files found): ${partialRecall.length} / ${comparisons.length}`
  );
  console.log(
    `  Zero recall (no files found):      ${zeroRecall.length} / ${comparisons.length}`
  );
  console.log(
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

  console.log(
    `  Token reduction vs entire codebase: ${fmtSavings(overallCodebaseSavingsAvg)} ` +
        `(${totalCodebaseTokens.toLocaleString()} -> ${(totalSfTokens / comparisons.length).toFixed(0)} avg tokens per task)`
  );
  console.log(
    `  When Spacefold saves tokens (avg of ${withSavings.length} tasks): ${avgSavingsWhenPositive.toFixed(1)}%`
  );
  console.log(
    `  Average budget utilization: ${((totalSfTokens / (TOKEN_BUDGET * comparisons.length)) * 100).toFixed(1)}%\n`
  );

  // ── Statistical significance (Bootstrap CI) ─────────────────────

  console.log(`${'='.repeat(78)}`);
  console.log(`  STATISTICAL SIGNIFICANCE — Bootstrap 95% CI (10,000 resamples)`);
  console.log(`${'='.repeat(78)}\n`);

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
    for (let b = 0; b < N_BOOT; b++) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        sum += values[Math.floor(Math.random() * n)];
      }
      bootMeans.push(sum / n);
    }
    bootMeans.sort((a, b) => a - b);

    const low = bootMeans[Math.floor(N_BOOT * 0.025)];
    const high = bootMeans[Math.ceil(N_BOOT * 0.975)];

    console.log(
      `  ${label.padEnd(18)} mean=${mean.toFixed(3)}  95% CI=[${low.toFixed(3)}, ${high.toFixed(3)}]  std=${std.toFixed(3)}`
    );
  }

  // ── Cleanup ─────────────────────────────────────────────────────

  pipeline.close();
  try {
    unlinkSync(dbPath);
  } catch {}

  console.log(`\n${'='.repeat(78)}`);
  console.log(`  E2E BENCHMARK COMPLETE`);
  console.log(`${'='.repeat(78)}\n`);
}

runE2EBenchmark().catch((err) => {
  console.error('E2E benchmark failed:', err);
  process.exit(1);
});
