import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { ContextScorer } from '../src/core/scorer.js';
import { ContextRouter, DEFAULT_ROUTING_CONFIG } from '../src/core/router.js';
import { ContextIngester } from '../src/core/ingester.js';
import { DeterministicTokenEstimator } from '../src/providers/token-estimator.js';
import { DeterministicEmbeddingProvider } from '../src/providers/deterministic-embedding.js';
import { DeterministicCompressionProvider } from '../src/providers/deterministic-compression.js';
import { SimpleDependencyAnalyzer } from '../src/providers/dependency-analyzer.js';
import { createRepository } from '../src/storage/repository.js';
import type { CodeSymbol, DependencyLink } from '../src/types/index.js';

let dbCounter = 0;
const dbPaths: string[] = [];
const projectDirs: string[] = [];
const originalDisableAst = process.env.SPACEFOLDING_DISABLE_AST_SUBPROCESS;

function createTestPipeline(): {
  pipeline: PipelineOrchestrator;
  dbPath: string;
  storage: ReturnType<typeof createRepository>;
} {
  dbCounter += 1;
  const dbPath = join(tmpdir(), `spacefolding-orchestrator-${Date.now()}-${dbCounter}.db`);
  dbPaths.push(dbPath);

  const storage = createRepository(dbPath);
  const tokenEstimator = new DeterministicTokenEstimator();
  const embeddingProvider = new DeterministicEmbeddingProvider();

  return {
    dbPath,
    storage,
    pipeline: new PipelineOrchestrator(
      storage,
      new ContextScorer(DEFAULT_ROUTING_CONFIG, embeddingProvider, tokenEstimator),
      new ContextRouter(DEFAULT_ROUTING_CONFIG),
      new DeterministicCompressionProvider(),
      new SimpleDependencyAnalyzer(),
      new ContextIngester(tokenEstimator),
      embeddingProvider
    ),
  };
}

function createProjectDir(files: Record<string, string>): string {
  dbCounter += 1;
  const dir = join(tmpdir(), `spacefolding-orchestrator-project-${Date.now()}-${dbCounter}`);
  projectDirs.push(dir);
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(dir, filePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return dir;
}

beforeEach(() => {
  process.env.SPACEFOLDING_DISABLE_AST_SUBPROCESS = '1';
});

afterEach(() => {
  if (originalDisableAst === undefined) {
    delete process.env.SPACEFOLDING_DISABLE_AST_SUBPROCESS;
  } else {
    process.env.SPACEFOLDING_DISABLE_AST_SUBPROCESS = originalDisableAst;
  }
});

afterAll(() => {
  for (const dbPath of dbPaths) {
    if (existsSync(dbPath)) unlinkSync(dbPath);
  }
  for (const dir of projectDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe('PipelineOrchestrator', () => {
  it('removeDependencies deletes links from storage', () => {
    const { pipeline } = createTestPipeline();
    const link: DependencyLink = {
      fromId: 'chunk-a',
      toId: 'chunk-b',
      type: 'references',
      weight: 0.7,
    };

    pipeline.addDependencies([link]);
    expect(pipeline.getDependencies('chunk-a')).toHaveLength(1);

    pipeline.removeDependencies([link]);
    expect(pipeline.getDependencies('chunk-a')).toHaveLength(0);

    pipeline.close();
  });

  it('preserves explicit type override when ingesting a file path', async () => {
    const { pipeline } = createTestPipeline();

    const chunk = await pipeline.ingest(
      'file',
      'Plain text that should not be auto-classified as code',
      'reference',
      'docs/reference.txt',
      'markdown'
    );

    expect(chunk.type).toBe('reference');
    expect(chunk.path).toBe('docs/reference.txt');

    pipeline.close();
  });

  it('infers supported language for project TypeScript files and stores symbols', async () => {
    const dir = createProjectDir({
      'src/app.ts': 'export function runApp() { return true; }',
    });
    const { pipeline, storage } = createTestPipeline();

    const result = await pipeline.ingestProject(dir, { includeDocs: false });
    const chunk = pipeline.getAllChunks().find((stored) => stored.path === 'src/app.ts');

    expect(result.codeFiles).toBe(1);
    expect(chunk?.language).toBe('typescript');
    expect(storage.getCodeSymbols(chunk!.id).map((symbol) => symbol.name)).toContain('runApp');

    pipeline.close();
  });

  it('clears stale structure for unsupported files on deduplicated ingest', async () => {
    const { pipeline, storage } = createTestPipeline();
    const markdown = '# Notes\n\nNo structural code should remain here.';
    const chunk = await pipeline.ingest('file', markdown, 'reference', 'docs/notes.md');
    const staleSymbol: CodeSymbol = {
      id: 'stale-symbol',
      chunkId: chunk.id,
      path: 'docs/notes.md',
      language: 'markdown',
      name: 'stale',
      normalizedName: 'stale',
      kind: 'function',
      signature: 'stale()',
      startLine: 1,
      endLine: 1,
      isExported: false,
      metadata: {},
    };
    storage.storeCodeStructure(chunk.id, [staleSymbol], []);
    expect(storage.getCodeSymbols(chunk.id)).toHaveLength(1);

    const deduped = await pipeline.ingest('file', markdown, 'reference', 'docs/notes.md');

    expect(deduped.id).toBe(chunk.id);
    expect(deduped.language).toBe('markdown');
    expect(storage.getCodeSymbols(chunk.id)).toEqual([]);

    pipeline.close();
  });

  it('refreshes supported file structure on re-ingest without appending duplicates', async () => {
    const { pipeline, storage } = createTestPipeline();
    const path = 'src/service.ts';

    const first = await pipeline.ingest(
      'file',
      'export function buildService() { return true; }',
      'code',
      path
    );
    expect(storage.getCodeSymbols(first.id).map((symbol) => symbol.name)).toEqual(['buildService']);

    const result = await pipeline.reingestFile(
      path,
      'export class Service {}\nexport interface ServiceContract {}',
      'code'
    );
    const currentSymbols = storage.getAllCodeSymbols()
      .filter((symbol) => symbol.path === path)
      .map((symbol) => `${symbol.kind}:${symbol.name}`)
      .sort();

    expect(result.changed).toBe(true);
    expect(currentSymbols).toEqual(['class:Service', 'interface:ServiceContract']);
    expect(currentSymbols).not.toContain('function:buildService');

    pipeline.close();
  });

  it('processContext returns empty tiers when storage has no chunks', async () => {
    const { pipeline } = createTestPipeline();

    await expect(pipeline.processContext({ text: 'Nothing to score' })).resolves.toEqual({
      hot: [],
      warm: [],
      cold: [],
      scores: {},
      reasons: {},
    });

    pipeline.close();
  });
});
