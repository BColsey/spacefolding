import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createRepository } from '../src/storage/repository.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { ContextScorer } from '../src/core/scorer.js';
import { ContextRouter, DEFAULT_ROUTING_CONFIG } from '../src/core/router.js';
import { ContextIngester } from '../src/core/ingester.js';
import { DeterministicTokenEstimator } from '../src/providers/token-estimator.js';
import { DeterministicEmbeddingProvider } from '../src/providers/deterministic-embedding.js';
import { DeterministicCompressionProvider } from '../src/providers/deterministic-compression.js';
import { SimpleDependencyAnalyzer } from '../src/providers/dependency-analyzer.js';
import { unlinkSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dbCounter = 0;
const dbPaths: string[] = [];
const testDirs: string[] = [];

function testDbPath(): string {
  dbCounter++;
  return join(tmpdir(), `sf-usability-${Date.now()}-${dbCounter}.db`);
}

function createTestPipeline(): { pipeline: PipelineOrchestrator; dbPath: string } {
  const dbPath = testDbPath();
  dbPaths.push(dbPath);
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
  return { pipeline, dbPath };
}

function createTestDir(name: string, files: Record<string, string>): string {
  const dir = join(tmpdir(), `sf-testdir-${name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(dir, path);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, content);
  }
  testDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const p of dbPaths) {
    if (existsSync(p)) unlinkSync(p);
  }
  for (const d of testDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true });
  }
});

describe('Usability: ingestDirectory', () => {
  it('ingests all files in a directory tree', async () => {
    const dir = createTestDir('basic', {
      'a.ts': 'const a = 1;',
      'b.ts': 'const b = 2;',
      'sub/c.ts': 'const c = 3;',
    });
    const { pipeline } = createTestPipeline();

    const result = await pipeline.ingestDirectory(dir);
    expect(result.files).toBe(3);
    expect(result.chunks.length).toBe(3);
    expect(result.skipped).toBe(0);

    const stats = pipeline.getStats();
    expect(stats.totalChunks).toBe(3);
  });

  it('skips binary files and excluded directories', async () => {
    const dir = createTestDir('exclusions', {
      'code.ts': 'const x = 1;',
      'image.png': 'binary-data-here',
      'node_modules/pkg/index.js': 'var a = 1;',
      '.git/config': 'git config',
    });
    const { pipeline } = createTestPipeline();

    const result = await pipeline.ingestDirectory(dir);
    expect(result.files).toBe(1);
    expect(result.chunks.length).toBe(1);
  });

  it('deduplicates already-ingested content', async () => {
    const dir = createTestDir('dedup', {
      'file.ts': 'const unique = true;',
    });
    const { pipeline } = createTestPipeline();

    const result1 = await pipeline.ingestDirectory(dir);
    expect(result1.chunks.length).toBe(1);

    const result2 = await pipeline.ingestDirectory(dir);
    expect(result2.chunks.length).toBe(1); // Same content, no new chunk

    const stats = pipeline.getStats();
    expect(stats.totalChunks).toBe(1);
  });
});

describe('Usability: getStats', () => {
  it('returns empty stats for empty storage', () => {
    const { pipeline } = createTestPipeline();
    const stats = pipeline.getStats();

    expect(stats.totalChunks).toBe(0);
    expect(stats.totalTokensEstimate).toBe(0);
    expect(stats.files).toHaveLength(0);
    expect(stats.oldestTimestamp).toBeNull();
    expect(stats.newestTimestamp).toBeNull();
  });

  it('returns per-file breakdown', async () => {
    const { pipeline } = createTestPipeline();

    await pipeline.ingest('file', 'function a() {}', 'code', 'src/a.ts', 'typescript');
    await pipeline.ingest('file', 'function b() {}', 'code', 'src/b.ts', 'typescript');
    await pipeline.ingest('conversation', 'Some note', 'fact');

    const stats = pipeline.getStats();
    expect(stats.totalChunks).toBe(3);
    expect(stats.files.length).toBe(3); // Two files + one conversation source
    expect(stats.oldestTimestamp).not.toBeNull();
    expect(stats.newestTimestamp).not.toBeNull();
    expect(stats.newestTimestamp!).toBeGreaterThanOrEqual(stats.oldestTimestamp!);
  });
});

describe('Usability: deleteChunks', () => {
  it('deletes chunks by ID', async () => {
    const { pipeline } = createTestPipeline();

    const c1 = await pipeline.ingest('file', 'chunk one', 'code', 'a.ts');
    const c2 = await pipeline.ingest('file', 'chunk two', 'code', 'b.ts');

    expect(pipeline.getStats().totalChunks).toBe(2);

    const deleted = pipeline.deleteChunks([c1.id]);
    expect(deleted).toBe(1);
    expect(pipeline.getStats().totalChunks).toBe(1);
  });

  it('handles deleting non-existent chunks gracefully', () => {
    const { pipeline } = createTestPipeline();
    const deleted = pipeline.deleteChunks(['nonexistent-id']);
    expect(deleted).toBe(1); // Still returns count of attempted deletes
  });
});

describe('Usability: eviction', () => {
  it('evicts oldest chunks when over limit', async () => {
    const { pipeline } = createTestPipeline();
    process.env.MAX_CHUNKS = '3';

    await pipeline.ingest('file', 'first chunk', 'code', '1.ts');
    await pipeline.ingest('file', 'second chunk', 'code', '2.ts');
    await pipeline.ingest('file', 'third chunk', 'code', '3.ts');
    expect(pipeline.getStats().totalChunks).toBe(3);

    // This should trigger eviction
    await pipeline.ingest('file', 'fourth chunk', 'code', '4.ts');
    expect(pipeline.getStats().totalChunks).toBe(3);

    delete process.env.MAX_CHUNKS;
  });
});
