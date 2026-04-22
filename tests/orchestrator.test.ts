import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { ContextScorer } from '../src/core/scorer.js';
import { ContextRouter, DEFAULT_ROUTING_CONFIG } from '../src/core/router.js';
import { ContextIngester } from '../src/core/ingester.js';
import { DeterministicTokenEstimator } from '../src/providers/token-estimator.js';
import { DeterministicEmbeddingProvider } from '../src/providers/deterministic-embedding.js';
import { DeterministicCompressionProvider } from '../src/providers/deterministic-compression.js';
import { SimpleDependencyAnalyzer } from '../src/providers/dependency-analyzer.js';
import { createRepository } from '../src/storage/repository.js';
import type { DependencyLink } from '../src/types/index.js';

let dbCounter = 0;
const dbPaths: string[] = [];

function createTestPipeline(): { pipeline: PipelineOrchestrator; dbPath: string } {
  dbCounter += 1;
  const dbPath = join(tmpdir(), `spacefolding-orchestrator-${Date.now()}-${dbCounter}.db`);
  dbPaths.push(dbPath);

  const storage = createRepository(dbPath);
  const tokenEstimator = new DeterministicTokenEstimator();
  const embeddingProvider = new DeterministicEmbeddingProvider();

  return {
    dbPath,
    pipeline: new PipelineOrchestrator(
      storage,
      new ContextScorer(DEFAULT_ROUTING_CONFIG, embeddingProvider, tokenEstimator),
      new ContextRouter(DEFAULT_ROUTING_CONFIG),
      new DeterministicCompressionProvider(),
      new SimpleDependencyAnalyzer(),
      new ContextIngester(tokenEstimator)
    ),
  };
}

afterAll(() => {
  for (const dbPath of dbPaths) {
    if (existsSync(dbPath)) unlinkSync(dbPath);
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

  it('preserves explicit type override when ingesting a file path', () => {
    const { pipeline } = createTestPipeline();

    const chunk = pipeline.ingest(
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
