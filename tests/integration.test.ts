import { describe, it, expect, afterAll } from 'vitest';
import { createRepository } from '../src/storage/repository.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { ContextScorer } from '../src/core/scorer.js';
import { ContextRouter, DEFAULT_ROUTING_CONFIG } from '../src/core/router.js';
import { ContextIngester } from '../src/core/ingester.js';
import { DeterministicTokenEstimator } from '../src/providers/token-estimator.js';
import { DeterministicEmbeddingProvider } from '../src/providers/deterministic-embedding.js';
import { DeterministicCompressionProvider } from '../src/providers/deterministic-compression.js';
import { SimpleDependencyAnalyzer } from '../src/providers/dependency-analyzer.js';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dbCounter = 0;

function testDbPath(): string {
  dbCounter++;
  return join(tmpdir(), `cs-test-${Date.now()}-${dbCounter}.db`);
}

const dbPaths: string[] = [];

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
    new ContextIngester(tokenEstimator)
  );
  return { pipeline, dbPath };
}

afterAll(() => {
  for (const p of dbPaths) {
    if (existsSync(p)) unlinkSync(p);
  }
});

describe('Integration: full pipeline', () => {
  it('ingests, scores, routes, compresses, and retrieves', async () => {
    const { pipeline } = createTestPipeline();
    const task = { text: 'Fix the authentication bug causing 401 errors in login.ts' };

    const constraintChunk = await pipeline.ingest(
      'conversation',
      'Must use JWT tokens for all API authentication. No session cookies.',
      'constraint'
    );
    const codeChunk = await pipeline.ingest(
      'file',
      'function authenticate(token: string) {\n  return false; // broken\n}',
      'code',
      'src/auth/login.ts',
      'typescript'
    );
    const logChunk = await pipeline.ingest(
      'log',
      '2024-01-15 10:30:00 ERROR 401 Unauthorized at /api/login',
      'log'
    );
    const backgroundChunk = await pipeline.ingest(
      'background',
      'The project was started in 2020 as a simple CRUD app. It uses Express and PostgreSQL.',
      'background'
    );

    const result = await pipeline.processContext(task);

    expect(result.hot.length + result.warm.length + result.cold.length).toBe(4);
    expect(result.hot).toContain(constraintChunk.id);
    expect(result.cold).toContain(backgroundChunk.id);
    expect(result.scores[constraintChunk.id]).toBeDefined();
    expect(result.reasons[constraintChunk.id].length).toBeGreaterThan(0);

    const { chunks, explanations } = await pipeline.getRelevantMemory(task);
    expect(chunks.length).toBeGreaterThan(0);
    expect(explanations.length).toBeGreaterThan(0);

    const { routing, summary } = await pipeline.explainRouting(task);
    expect(routing.length).toBe(4);
    expect(summary).toContain('4');
  });

  it('handles empty context gracefully', async () => {
    const { pipeline } = createTestPipeline();
    const task = { text: 'Do something' };

    const result = await pipeline.processContext(task);
    expect(result.hot).toHaveLength(0);
    expect(result.warm).toHaveLength(0);
    expect(result.cold).toHaveLength(0);
  });

  it('supports incremental ingestion', async () => {
    const { pipeline } = createTestPipeline();
    const task = { text: 'Fix auth bug' };

    const chunk1 = await pipeline.ingest('conversation', 'Fix the login bug', 'instruction');
    const result1 = await pipeline.processContext(task);
    expect(result1.hot.length + result1.warm.length + result1.cold.length).toBe(1);

    const chunk2 = await pipeline.ingest('file', 'function login() {}', 'code', 'login.ts', 'typescript');
    const result2 = await pipeline.processContext(task);
    expect(result2.hot.length + result2.warm.length + result2.cold.length).toBe(2);
  });
});
