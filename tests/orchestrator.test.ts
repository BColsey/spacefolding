import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { ContextScorer } from '../src/core/scorer.js';
import { ContextRouter, DEFAULT_ROUTING_CONFIG } from '../src/core/router.js';
import { ContextIngester } from '../src/core/ingester.js';
import type { ChunkingConfig } from '../src/core/chunker.js';
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

function createTestPipeline(chunkingConfig?: ChunkingConfig): {
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
      new ContextIngester(tokenEstimator, chunkingConfig),
      embeddingProvider
    ),
  };
}

function functionBlock(name: string, word: string): string {
  const rows = Array.from({ length: 48 }, (_, index) => `    '${word}-${index}',`);
  return `export function ${name}() {\n  return [\n${rows.join('\n')}\n  ].join(' ');\n}`;
}

function compactFunctionBlock(name: string, word: string): string {
  const rows = Array.from({ length: 8 }, (_, index) => `    '${word}-${index}',`);
  return `export function ${name}() {\n  return [\n${rows.join('\n')}\n  ].join(' ');\n}`;
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

  it('normalizes file paths across ingest, structure, and re-ingest', async () => {
    const { pipeline, storage } = createTestPipeline();
    const rawPath = 'src\\feature\\service.ts';
    const normalizedPath = 'src/feature/service.ts';
    const content = 'export function runService() { return true; }';

    const chunk = await pipeline.ingest('file', content, 'code', rawPath);
    const result = await pipeline.reingestFile(rawPath, content, 'code');
    const chunksForPath = pipeline.getAllChunks().filter((stored) => stored.path === normalizedPath);
    const symbolsForPath = storage.getAllCodeSymbols().filter((symbol) => symbol.path === normalizedPath);

    expect(chunk.path).toBe(normalizedPath);
    expect(result).toMatchObject({
      path: normalizedPath,
      changed: false,
      chunks: [chunk.id],
      reusedChunks: 1,
      createdChunks: 0,
      deletedChunks: 0,
      totalChunks: 1,
    });
    expect(pipeline.getAllChunks().some((stored) => stored.path === rawPath)).toBe(false);
    expect(chunksForPath.map((stored) => stored.id)).toEqual([chunk.id]);
    expect(symbolsForPath.map((symbol) => symbol.name)).toEqual(['runService']);

    pipeline.close();
  });

  it('counts unreadable project files as skipped', async () => {
    const dir = createProjectDir({
      'src/unreadable.ts': 'export function hidden() { return true; }',
    });
    const unreadablePath = join(dir, 'src/unreadable.ts');
    const { pipeline } = createTestPipeline();

    chmodSync(unreadablePath, 0o000);
    try {
      const result = await pipeline.ingestProject(dir, { includeDocs: false });

      expect(result.files).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.chunks).toEqual([]);
      expect(result.codeFiles).toBe(0);
    } finally {
      chmodSync(unreadablePath, 0o600);
      pipeline.close();
    }
  });

  it('does not treat storage failures during project ingest as skipped files', async () => {
    const dir = createProjectDir({
      'src/app.ts': 'export function runApp() { return true; }',
    });
    const { pipeline, storage } = createTestPipeline();
    const storeError = new Error('database write failed');
    const storeSpy = vi.spyOn(storage, 'storeChunk').mockImplementation(() => {
      throw storeError;
    });

    try {
      await expect(pipeline.ingestProject(dir, { includeDocs: false })).rejects.toThrow(storeError);
    } finally {
      storeSpy.mockRestore();
      pipeline.close();
    }
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

  it('reports unchanged file re-ingest without duplicating chunks or structure', async () => {
    const { pipeline, storage } = createTestPipeline();
    const path = 'src/unchanged.ts';
    const content = 'export function unchangedService() { return true; }';

    const first = await pipeline.ingest('file', content, 'code', path);
    const result = await pipeline.reingestFile(path, content, 'code');
    const chunksForPath = pipeline.getAllChunks().filter((chunk) => chunk.path === path);
    const symbolsForPath = storage.getAllCodeSymbols()
      .filter((symbol) => symbol.path === path)
      .map((symbol) => symbol.name);

    expect(result).toMatchObject({
      path,
      changed: false,
      chunks: [first.id],
      reusedChunks: 1,
      createdChunks: 0,
      deletedChunks: 0,
      totalChunks: 1,
    });
    expect(chunksForPath.map((chunk) => chunk.id)).toEqual([first.id]);
    expect(symbolsForPath).toEqual(['unchangedService']);

    pipeline.close();
  });

  it('removes stale split children from storage, embeddings, dependencies, FTS, and code structure', async () => {
    const { pipeline, storage } = createTestPipeline({
      maxTokens: 80,
      overlapTokens: 0,
      strategy: 'code',
    });
    const embeddingProvider = new DeterministicEmbeddingProvider();
    const path = 'src/reingest-target.ts';
    const stableAlpha = functionBlock('stableAlpha', 'alpha');
    const oldMutable = functionBlock('oldMutable', 'old');
    const newMutable = functionBlock('newMutable', 'new');
    const stableBeta = functionBlock('stableBeta', 'beta');

    await pipeline.ingest(
      'file',
      [stableAlpha, oldMutable, stableBeta].join('\n\n'),
      'code',
      path
    );
    const before = pipeline.getAllChunks().filter((chunk) => chunk.path === path);
    const reusableChild = before.find((chunk) => !chunk.metadata.split && chunk.text.includes('stableAlpha'));
    const staleChild = before.find((chunk) => !chunk.metadata.split && chunk.text.includes('oldMutable'));

    expect(reusableChild).toBeDefined();
    expect(staleChild).toBeDefined();
    expect(storage.getEmbedding(reusableChild!.id)).not.toBeNull();
    expect(storage.getEmbedding(staleChild!.id)).not.toBeNull();
    expect(storage.getCodeSymbols(staleChild!.id).map((symbol) => symbol.name)).toContain('oldMutable');
    expect(storage.getDependencies(staleChild!.id).some((link) => link.type === 'contains')).toBe(true);

    storage.initVectorIndex(384);
    const staleQuery = await embeddingProvider.embed(staleChild!.text);
    expect(storage.searchByVector(staleQuery, 20).map((result) => result.chunkId)).toContain(staleChild!.id);

    const result = await pipeline.reingestFile(
      path,
      [stableAlpha, newMutable, stableBeta].join('\n\n'),
      'code'
    );
    const after = pipeline.getAllChunks().filter((chunk) => chunk.path === path);
    const afterIds = new Set(after.map((chunk) => chunk.id));
    const parent = after.find((chunk) => chunk.metadata.split);
    const childIds = after
      .filter((chunk) => chunk.parentId === parent?.id)
      .map((chunk) => chunk.id)
      .sort();
    const containsIds = parent
      ? storage.getDependencies(parent.id)
        .filter((link) => link.type === 'contains' && link.fromId === parent.id)
        .map((link) => link.toId)
        .sort()
      : [];

    expect(result.changed).toBe(true);
    expect(result.reusedChunks).toBeGreaterThanOrEqual(2);
    expect(afterIds.has(reusableChild!.id)).toBe(true);
    expect(storage.getEmbedding(reusableChild!.id)).not.toBeNull();
    expect(storage.searchByVector(await embeddingProvider.embed(reusableChild!.text), 20).map((row) => row.chunkId))
      .toContain(reusableChild!.id);
    expect(storage.getChunk(staleChild!.id)).toBeNull();
    expect(storage.getEmbedding(staleChild!.id)).toBeNull();
    expect(storage.getDependencies(staleChild!.id)).toEqual([]);
    expect(storage.getCodeSymbols(staleChild!.id)).toEqual([]);
    expect(storage.getCodeReferences(staleChild!.id)).toEqual([]);
    expect(storage.searchByVector(staleQuery, 50).map((row) => row.chunkId)).not.toContain(staleChild!.id);
    expect(storage.searchByText('oldMutable', 20).map((row) => row.chunkId)).not.toContain(staleChild!.id);
    expect(containsIds).toEqual(childIds);
    expect(containsIds).not.toContain(staleChild!.id);

    pipeline.close();
  });

  it('focused retrieval excludes split metadata parent chunks', async () => {
    const { pipeline } = createTestPipeline({
      maxTokens: 80,
      overlapTokens: 0,
      strategy: 'code',
    });
    const path = 'src/focused-parent.ts';

    await pipeline.ingest(
      'file',
      [
        compactFunctionBlock('findParentNeedle', 'needle'),
        compactFunctionBlock('otherFeature', 'other'),
        compactFunctionBlock('thirdFeature', 'third'),
      ].join('\n\n'),
      'code',
      path
    );

    const parent = pipeline.getAllChunks()
      .find((chunk) => chunk.path === path && chunk.metadata.split);
    const result = await pipeline.retrieve('findParentNeedle needle', 1_000, {
      strategy: 'text',
      mode: 'focused',
      topK: 10,
    });
    const returnedIds = result.chunks.map((chunk) => chunk.id);

    expect(parent).toBeDefined();
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(returnedIds).not.toContain(parent!.id);
    expect(result.chunks.every((chunk) => !chunk.metadata.split)).toBe(true);

    pipeline.close();
  });

  it('focused retrieval reports dropped candidate reasons', async () => {
    const { pipeline } = createTestPipeline();

    for (let index = 0; index < 5; index++) {
      await pipeline.ingest(
        'shared-source',
        `shared needle ranking candidate ${index}`,
        'reference'
      );
    }

    const result = await pipeline.retrieve('shared needle ranking', 10_000, {
      strategy: 'text',
      mode: 'focused',
      topK: 10,
      returnLimit: 10,
    });

    expect(result.dropped.length).toBeGreaterThan(0);
    expect(result.selectionPolicy.droppedCandidates).toBe(result.dropped.length);
    expect(result.dropped.some((drop) => drop.reason.includes('per-path'))).toBe(true);

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
