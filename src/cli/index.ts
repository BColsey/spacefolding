import { Command } from 'commander';
import chalk from 'chalk';
import type { Server as HttpServer } from 'node:http';
import { createRepository } from '../storage/repository.js';
import { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { ContextScorer } from '../core/scorer.js';
import { ContextRouter, DEFAULT_ROUTING_CONFIG } from '../core/router.js';
import { ContextIngester } from '../core/ingester.js';
import { FileWatcher } from '../core/watcher.js';
import { DeterministicTokenEstimator } from '../providers/token-estimator.js';
import { DeterministicEmbeddingProvider } from '../providers/deterministic-embedding.js';
import { DeterministicCompressionProvider } from '../providers/deterministic-compression.js';
import { LocalCompressionProvider } from '../providers/local-compression.js';
import { SimpleDependencyAnalyzer } from '../providers/dependency-analyzer.js';
import { extractSymbols } from '../providers/symbol-extractor.js';
import { LocalEmbeddingProvider, downloadModel } from '../providers/local-embedding.js';
import { startMCPServer } from '../mcp/server.js';
import { startWebServer } from '../web/server.js';
import { exportState, importState } from './commands/export-import.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

function createPipeline(dbPath: string): PipelineOrchestrator {
  const storage = createRepository(dbPath);
  const tokenEstimator = new DeterministicTokenEstimator();
  const embeddingProvider = process.env.EMBEDDING_PROVIDER === 'local'
    ? new LocalEmbeddingProvider(process.env.EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2')
    : new DeterministicEmbeddingProvider();
  const compressionProvider = process.env.COMPRESSION_PROVIDER === 'local'
    ? new LocalCompressionProvider(process.env.COMPRESSION_MODEL ?? 'Xenova/all-MiniLM-L6-v2')
    : new DeterministicCompressionProvider();
  const dependencyAnalyzer = new SimpleDependencyAnalyzer();

  const scorer = new ContextScorer(DEFAULT_ROUTING_CONFIG, embeddingProvider, tokenEstimator);
  const router = new ContextRouter(DEFAULT_ROUTING_CONFIG);
  const ingester = new ContextIngester(tokenEstimator);

  return new PipelineOrchestrator(
    storage,
    scorer,
    router,
    compressionProvider,
    dependencyAnalyzer,
    ingester
  );
}

async function runDownloadModel(modelId: string): Promise<void> {
  try {
    await downloadModel(modelId);
    console.log(chalk.green('\n✓ Model downloaded successfully'));
  } catch (err) {
    console.error(chalk.red('Failed to download model:'), err);
    process.exit(1);
  }
}

function getDownloadModelId(): string {
  const rawArgs = process.argv.slice(2);
  const modelIndex = rawArgs.indexOf('--model');
  if (modelIndex >= 0 && rawArgs[modelIndex + 1]) {
    return rawArgs[modelIndex + 1];
  }
  return process.env.EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2';
}

function warnIfOutsideWorkspace(inputPath: string): void {
  if (inputPath.startsWith('/workspace') || inputPath.startsWith('./workspace')) {
    return;
  }
  console.error(
    chalk.yellow(`Warning: ingest path "${inputPath}" is outside /workspace`) 
  );
}

function registerShutdown(pipeline: PipelineOrchestrator, webServer?: HttpServer): void {
  let closed = false;
  const shutdown = (signal: string) => {
    if (closed) return;
    closed = true;
    console.error(chalk.yellow(`Received ${signal}, shutting down Spacefolding...`));
    webServer?.close();
    pipeline.close();
    process.exit(0);
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

async function startServe(
  dbPath: string,
  transport: 'stdio' | 'sse',
  port: number
): Promise<void> {
  console.error(chalk.blue('Starting Spacefolding MCP server...'));
  const pipeline = createPipeline(dbPath);
  const webPort = parseInt(process.env.WEB_PORT ?? '0', 10);
  const webServer = Number.isFinite(webPort) && webPort > 0
    ? startWebServer({ port: webPort, pipeline })
    : undefined;
  registerShutdown(pipeline, webServer);
  await startMCPServer(pipeline, { transport, port });
  console.error(
    chalk.green(
      `Spacefolding MCP server running on ${transport === 'sse' ? `SSE port ${port}` : 'stdio'}`
    )
  );
  if (webServer) {
    console.error(chalk.green(`Spacefolding web UI running on http://localhost:${webPort}`));
  }
}

export function buildCLI(): Command {
  const program = new Command();

  program
    .name('spacefolding')
    .description('Spacefolding — context compression and routing for coding agents')
    .version('0.1.0')
    .option('--db <path>', 'Database path', process.env.DB_PATH ?? './data/spacefolding.db')
    .action(async () => {
      await startServe(
        program.opts().db,
        (process.env.TRANSPORT ?? 'stdio') as 'stdio' | 'sse',
        parseInt(process.env.PORT ?? '3000', 10)
      );
    });

  program
    .command('serve')
    .description('Start MCP server (default command)')
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    .option('--transport <type>', 'Transport type: stdio or sse', process.env.TRANSPORT ?? 'stdio')
    .option('--port <number>', 'Port for SSE transport', process.env.PORT ?? '3000')
    .action(async (opts, cmd) => {
      if (process.argv.slice(2)[0] === 'download-model') {
        await runDownloadModel(getDownloadModelId());
        return;
      }

      const dbPath = cmd.parent?.opts().db ?? process.env.DB_PATH ?? './data/spacefolding.db';
      await startServe(dbPath, opts.transport as 'stdio' | 'sse', parseInt(opts.port, 10));
    });

  program
    .command('ingest')
    .description('Ingest a file or directory')
    .argument('<path>', 'File or directory path to ingest')
    .option('--source <source>', 'Source label', 'file')
    .option('--type <type>', 'Chunk type override')
    .action(async (inputPath, opts, cmd) => {
      const dbPath = cmd.parent?.opts().db ?? process.env.DB_PATH ?? './data/spacefolding.db';
      const pipeline = createPipeline(dbPath);

      warnIfOutsideWorkspace(inputPath);

      const stat = statSync(inputPath);
      if (stat.isDirectory()) {
        const files = walkDir(inputPath);
        for (const filePath of files) {
          const content = readFileSync(filePath, 'utf-8');
          const chunk = pipeline.ingest('file', content, opts.type, filePath);
          console.log(chalk.green('✓'), chunk.id, filePath);
        }
        console.log(chalk.blue(`Ingested ${files.length} files`));
      } else {
        const content = readFileSync(inputPath, 'utf-8');
        const chunk = pipeline.ingest(opts.source, content, opts.type, inputPath);
        console.log(chalk.green('✓'), chunk.id, inputPath);
      }
    });

  program
    .command('score')
    .description('Score current context against a task')
    .requiredOption('--task <text>', 'Task description')
    .action(async (opts, cmd) => {
      const dbPath = cmd.parent?.opts().db ?? process.env.DB_PATH ?? './data/spacefolding.db';
      const pipeline = createPipeline(dbPath);
      const result = await pipeline.processContext({ text: opts.task });

      console.log(chalk.red('\n=== HOT ==='));
      for (const id of result.hot) {
        const score = result.scores[id]?.toFixed(3);
        console.log(`  ${chalk.red(id.slice(0, 8))} (${score})`);
      }

      console.log(chalk.yellow('\n=== WARM ==='));
      for (const id of result.warm) {
        const score = result.scores[id]?.toFixed(3);
        console.log(`  ${chalk.yellow(id.slice(0, 8))} (${score})`);
      }

      console.log(chalk.blue('\n=== COLD ==='));
      for (const id of result.cold) {
        const score = result.scores[id]?.toFixed(3);
        console.log(`  ${chalk.blue(id.slice(0, 8))} (${score})`);
      }

      console.log(
        chalk.gray(`\nTotals: ${result.hot.length} hot, ${result.warm.length} warm, ${result.cold.length} cold`)
      );
    });

  program
    .command('explain')
    .description('Explain routing decisions for a task')
    .requiredOption('--task <text>', 'Task description')
    .option('--chunk <id>', 'Explain a specific chunk')
    .action(async (opts, cmd) => {
      const dbPath = cmd.parent?.opts().db ?? process.env.DB_PATH ?? './data/spacefolding.db';
      const pipeline = createPipeline(dbPath);
      const { routing, summary } = await pipeline.explainRouting(
        { text: opts.task },
        opts.chunk
      );

      console.log(chalk.bold(summary));
      console.log();
      for (const decision of routing) {
        const tierColor =
          decision.tier === 'hot' ? chalk.red : decision.tier === 'warm' ? chalk.yellow : chalk.blue;
        console.log(
          tierColor(`[${decision.tier.toUpperCase()}]`),
          decision.chunkId.slice(0, 8),
          `score: ${decision.score.toFixed(3)}`
        );
        for (const reason of decision.reasons) {
          console.log(chalk.gray(`  → ${reason}`));
        }
      }
    });

  program
    .command('graph')
    .description('Inspect chunk dependency graph')
    .option('--chunk <id>', 'Show dependencies for a specific chunk')
    .action(async (opts, cmd) => {
      const dbPath = cmd.parent?.opts().db ?? process.env.DB_PATH ?? './data/spacefolding.db';
      const pipeline = createPipeline(dbPath);

      if (!opts.chunk) {
        console.log(chalk.yellow('Specify --chunk <id> to see dependencies'));
        return;
      }

      const deps = pipeline.getDependencies(opts.chunk);
      if (deps.length === 0) {
        console.log(chalk.gray('No dependencies found'));
        return;
      }

      for (const dep of deps) {
        const arrow = dep.fromId === opts.chunk ? '→' : '←';
        const otherId = dep.fromId === opts.chunk ? dep.toId : dep.fromId;
        console.log(
          `  ${arrow} ${otherId.slice(0, 8)} (${dep.type}, weight: ${dep.weight})`
        );
      }
    });

  program
    .command('watch')
    .description('Watch a path and ingest file changes automatically')
    .argument('<path>', 'Path to watch')
    .action((watchPath, _opts, cmd) => {
      const dbPath = cmd.parent?.opts().db ?? process.env.DB_PATH ?? './data/spacefolding.db';
      const pipeline = createPipeline(dbPath);
      const watcher = new FileWatcher(watchPath, pipeline);
      watcher.start();
      console.error(chalk.blue(`Watching ${watchPath} for changes...`));

      let closed = false;
      const shutdown = (signal: string) => {
        if (closed) return;
        closed = true;
        console.error(chalk.yellow(`Received ${signal}, stopping watcher...`));
        watcher.stop();
        pipeline.close();
        process.exit(0);
      };

      process.once('SIGTERM', () => shutdown('SIGTERM'));
      process.once('SIGINT', () => shutdown('SIGINT'));
    });

  program
    .command('export')
    .description('Export memory state to a JSON file')
    .argument('<output-path>', 'Output JSON path')
    .action(async (outputPath, _opts, cmd) => {
      const dbPath = cmd.parent?.opts().db ?? process.env.DB_PATH ?? './data/spacefolding.db';
      await exportState(dbPath, outputPath);
      console.log(chalk.green(`Exported state to ${outputPath}`));
    });

  program
    .command('import')
    .description('Import memory state from a JSON file')
    .argument('<input-path>', 'Input JSON path')
    .action(async (inputPath, _opts, cmd) => {
      const dbPath = cmd.parent?.opts().db ?? process.env.DB_PATH ?? './data/spacefolding.db';
      await importState(dbPath, inputPath);
      console.log(chalk.green(`Imported state from ${inputPath}`));
    });

  program
    .command('symbols')
    .description('Extract symbols from a source file')
    .argument('<path>', 'Source file path')
    .action((inputPath) => {
      const content = readFileSync(inputPath, 'utf-8');
      const symbols = extractSymbols(content, detectLanguage(inputPath), inputPath);

      if (symbols.length === 0) {
        console.log(chalk.yellow('No symbols found'));
        return;
      }

      for (const symbol of symbols) {
        console.log(`${symbol.kind}\t${symbol.name}\tline ${symbol.line}`);
      }
    });

  program
    .command('download-model')
    .description('Download a local embedding model for offline use')
    .option('--model <id>', 'HuggingFace model ID', process.env.EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2')
    .action(async (opts) => {
      await runDownloadModel(opts.model);
    });

  program
    .command('health')
    .description('Health check')
    .action((_opts, cmd) => {
      const dbPath = cmd.parent?.opts().db ?? process.env.DB_PATH ?? './data/spacefolding.db';
      try {
        const pipeline = createPipeline(dbPath);
        console.log(JSON.stringify({ status: 'ok', chunks: pipeline.getAllChunks().length }));
      } catch (err) {
        console.log(JSON.stringify({ status: 'error', message: String(err) }));
        process.exit(1);
      }
    });

  return program;
}

function detectLanguage(filePath: string): string | undefined {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.ts' || extension === '.tsx') return 'typescript';
  if (extension === '.js' || extension === '.jsx') return 'javascript';
  if (extension === '.py') return 'python';
  return undefined;
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
      const ext = extname(entry);
      if (!['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot'].includes(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}
