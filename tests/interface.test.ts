import { afterEach, describe, expect, it } from 'vitest';
import { buildCLI, parseRetrieveCommandOptions } from '../src/cli/index.js';
import { TOOL_DEFINITIONS, validateArgs } from '../src/mcp/server.js';
import { createWebRequestHandler } from '../src/web/server.js';
import { createRepository } from '../src/storage/repository.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { ContextScorer } from '../src/core/scorer.js';
import { ContextRouter, DEFAULT_ROUTING_CONFIG } from '../src/core/router.js';
import { ContextIngester } from '../src/core/ingester.js';
import { DeterministicTokenEstimator } from '../src/providers/token-estimator.js';
import { DeterministicEmbeddingProvider } from '../src/providers/deterministic-embedding.js';
import { DeterministicCompressionProvider } from '../src/providers/deterministic-compression.js';
import { SimpleDependencyAnalyzer } from '../src/providers/dependency-analyzer.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

interface WebFixture {
  pipeline: PipelineOrchestrator;
}

interface WebTestResponse {
  status: number;
  body: string;
  json: <T>() => T;
}

const webFixtures: Array<{ pipeline: PipelineOrchestrator; dir: string }> = [];

function createWebFixture(): WebFixture {
  const dir = mkdtempSync(join(tmpdir(), 'spacefolding-web-test-'));
  const dbPath = join(dir, 'spacefolding.db');
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
  webFixtures.push({ pipeline, dir });
  return { pipeline };
}

async function requestWeb(pipeline: PipelineOrchestrator, url: string, method = 'GET'): Promise<WebTestResponse> {
  let status = 0;
  let body = '';
  const handler = createWebRequestHandler(pipeline);
  await handler(
    { method, url },
    {
      writeHead(nextStatus) {
        status = nextStatus;
      },
      end(data) {
        body = data;
      },
    }
  );
  return {
    status,
    body,
    json: <T>() => JSON.parse(body) as T,
  };
}

afterEach(() => {
  const fixtures = webFixtures.splice(0);
  for (const fixture of fixtures) {
    fixture.pipeline.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

describe('CLI interface', () => {
  it('exposes project ingestion and retrieval selection options', () => {
    const cli = buildCLI();
    const ingestProject = cli.commands.find((command) => command.name() === 'ingest-project');
    const retrieve = cli.commands.find((command) => command.name() === 'retrieve');

    expect(ingestProject).toBeDefined();
    expect(ingestProject?.options.map((option) => option.long)).toContain('--include-tests');
    expect(ingestProject?.options.map((option) => option.long)).toContain('--include-benchmarks');
    expect(ingestProject?.options.map((option) => option.long)).toContain('--no-docs');
    expect(retrieve?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--mode', '--return-limit', '--top-k'])
    );
  });

  it('retrieve command has mode, strategy, max-tokens, and top-k options', () => {
    const cli = buildCLI();
    const retrieve = cli.commands.find((command) => command.name() === 'retrieve');
    const optionLongs = retrieve?.options.map((option) => option.long) ?? [];

    expect(optionLongs).toContain('--mode');
    expect(optionLongs).toContain('--strategy');
    expect(optionLongs).toContain('--max-tokens');
    expect(optionLongs).toContain('--top-k');
    expect(optionLongs).toContain('--return-limit');
    expect(optionLongs).toContain('--max-hops');
  });

  it('retrieve command mode option describes focused, broad, exhaustive', () => {
    const cli = buildCLI();
    const retrieve = cli.commands.find((command) => command.name() === 'retrieve');
    const modeOpt = retrieve?.options.find((option) => option.long === '--mode');

    expect(modeOpt?.description).toContain('focused');
    expect(modeOpt?.description).toContain('broad');
    expect(modeOpt?.description).toContain('exhaustive');
  });

  it('retrieve command max-hops option describes the disabled graph default', () => {
    const cli = buildCLI();
    const retrieve = cli.commands.find((command) => command.name() === 'retrieve');
    const maxHopsOpt = retrieve?.options.find((option) => option.long === '--max-hops');

    expect(maxHopsOpt?.defaultValue).toBe('0');
    expect(maxHopsOpt?.description).toContain('default: 0');
    expect(maxHopsOpt?.description).toContain('disabled');
  });

  it('retrieve command defaults to focused mode', () => {
    const cli = buildCLI();
    const retrieve = cli.commands.find((command) => command.name() === 'retrieve');
    const modeOpt = retrieve?.options.find((option) => option.long === '--mode');

    expect(modeOpt?.defaultValue).toBe('focused');
  });

  it('strictly parses retrieve numeric options', () => {
    const parsed = parseRetrieveCommandOptions({
      query: 'find auth',
      maxTokens: '50000',
      mode: 'focused',
      strategy: 'structural',
      topK: '12',
      returnLimit: '8',
      maxHops: '0',
    });

    expect(parsed.error).toBeUndefined();
    expect(parsed.options).toEqual({
      query: 'find auth',
      maxTokens: 50000,
      mode: 'focused',
      strategy: 'structural',
      topK: 12,
      returnLimit: 8,
      maxHops: 0,
    });
  });

  it('rejects malformed retrieve numeric options before running retrieval', () => {
    expect(parseRetrieveCommandOptions({ query: 'x', maxTokens: '5abc' }).error).toContain('--max-tokens');
    expect(parseRetrieveCommandOptions({ query: 'x', maxTokens: '0' }).error).toContain('--max-tokens');
    expect(parseRetrieveCommandOptions({ query: 'x', topK: '1.5' }).error).toContain('--top-k');
    expect(parseRetrieveCommandOptions({ query: 'x', returnLimit: '0' }).error).toContain('--return-limit');
    expect(parseRetrieveCommandOptions({ query: 'x', maxHops: '-1' }).error).toContain('--max-hops');
    expect(parseRetrieveCommandOptions({ query: '   ' }).error).toContain('query must be a non-empty string');
    expect(parseRetrieveCommandOptions({ query: 'x', mode: 'all' }).error).toContain('Invalid mode');
    expect(parseRetrieveCommandOptions({ query: 'x', strategy: 'all' }).error).toContain('Invalid strategy');
  });
});

describe('MCP interface', () => {
  it('exposes ingest_project and focused retrieval controls', () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);
    const retrieve = TOOL_DEFINITIONS.find((tool) => tool.name === 'retrieve_context');
    const ingestProject = TOOL_DEFINITIONS.find((tool) => tool.name === 'ingest_project');

    expect(names).toContain('ingest_project');
    expect(retrieve?.inputSchema.properties).toHaveProperty('mode');
    expect(retrieve?.inputSchema.properties).toHaveProperty('returnLimit');
    expect(ingestProject?.inputSchema.properties).toHaveProperty('includeTests');
    expect(ingestProject?.inputSchema.properties).toHaveProperty('includeBenchmarks');
  });

  it('retrieve_context mode enum accepts focused, broad, and exhaustive', () => {
    const retrieve = TOOL_DEFINITIONS.find((tool) => tool.name === 'retrieve_context');
    const modeProp = retrieve?.inputSchema.properties.mode as { enum?: string[] };
    expect(modeProp?.enum).toEqual(['focused', 'broad', 'exhaustive']);
  });

  it('retrieve_context strategy enum accepts all retrieval strategies', () => {
    const retrieve = TOOL_DEFINITIONS.find((tool) => tool.name === 'retrieve_context');
    const strategyProp = retrieve?.inputSchema.properties.strategy as { enum?: string[] };
    expect(strategyProp?.enum).toEqual(['structural', 'hybrid', 'vector', 'text', 'graph']);
  });

  it('retrieve_context schema describes mode, strategy, budget, and query options', () => {
    const retrieve = TOOL_DEFINITIONS.find((tool) => tool.name === 'retrieve_context');
    const props = retrieve?.inputSchema.properties as Record<string, { description?: string }>;

    expect(props.query?.description).toBeTruthy();
    expect(props.mode?.description).toBeTruthy();
    expect(props.strategy?.description).toBeTruthy();
    expect(props.maxTokens?.description).toBeTruthy();
    expect(props.topK?.description).toBeTruthy();
    expect(props.returnLimit?.description).toBeTruthy();
    expect(props.maxHops?.description).toContain('default: 0');
    expect(props.maxHops?.description).toContain('disabled');
  });

  it('iterative_retrieve describes structural default strategy wiring', () => {
    const iterative = TOOL_DEFINITIONS.find((tool) => tool.name === 'iterative_retrieve');
    const strategy = iterative?.inputSchema.properties.strategy as { description?: string };

    expect(strategy?.description).toContain('structural when code symbols are indexed');
  });
});

describe('MCP input validation', () => {
  it('rejects invalid strategy with useful message', () => {
    const error = validateArgs({ strategy: 'invalid_strategy' });
    expect(error).toBeTruthy();
    expect(error).toContain('strategy must be one of');
    expect(error).toContain('structural');
    expect(error).toContain('hybrid');
  });

  it('rejects invalid mode with useful message', () => {
    const error = validateArgs({ mode: 'ultra' });
    expect(error).toBeTruthy();
    expect(error).toContain('mode must be one of');
    expect(error).toContain('focused');
    expect(error).toContain('broad');
    expect(error).toContain('exhaustive');
  });

  it('accepts valid mode and strategy', () => {
    expect(validateArgs({ mode: 'focused', strategy: 'structural' })).toBeUndefined();
    expect(validateArgs({ mode: 'broad', strategy: 'hybrid' })).toBeUndefined();
    expect(validateArgs({ mode: 'exhaustive', strategy: 'vector' })).toBeUndefined();
  });

  it('accepts request without mode or strategy', () => {
    expect(validateArgs({ query: 'test' })).toBeUndefined();
  });

  it('rejects invalid retrieve numeric controls with useful messages', () => {
    expect(validateArgs({ query: 'test', maxTokens: 0 })).toContain('maxTokens must be a positive integer');
    expect(validateArgs({ query: 'test', topK: 1.5 })).toContain('topK must be a positive integer');
    expect(validateArgs({ query: 'test', returnLimit: -1 })).toContain('returnLimit must be a positive integer');
    expect(validateArgs({ query: 'test', maxHops: -1 })).toContain('maxHops must be a non-negative integer');
    expect(validateArgs({ query: 'test', rounds: 0 })).toContain('rounds must be a positive integer');
  });

  it('rejects missing or empty retrieve query', () => {
    expect(validateArgs({ query: '' })).toContain('query must be a non-empty string');
    expect(validateArgs({ query: 42 })).toContain('query must be a non-empty string');
  });
});

describe('Web inspector interface', () => {
  it('returns per-file chunk counts and token totals from stats endpoint', async () => {
    const { pipeline } = createWebFixture();

    await pipeline.ingest(
      'file',
      'export function WebStatsPanel() { return true; }',
      'code',
      'src/web/stats.ts',
      'typescript'
    );
    await pipeline.ingest(
      'file',
      'export function WebStatsFooter() { return false; }',
      'code',
      'src/web/stats.ts',
      'typescript'
    );

    const response = await requestWeb(pipeline, '/api/stats');
    expect(response.status).toBe(200);
    const stats = response.json<{
      totalChunks: number;
      totalTokensEstimate: number;
      files: Array<{ path: string; chunkCount: number; tokensEstimate: number }>;
    }>();

    expect(stats.totalChunks).toBe(2);
    expect(stats.totalTokensEstimate).toBeGreaterThan(0);
    expect(stats.files).toContainEqual(
      expect.objectContaining({
        path: 'src/web/stats.ts',
        chunkCount: 2,
        tokensEstimate: expect.any(Number),
      })
    );
    expect(stats.files[0]?.tokensEstimate).toBeGreaterThan(0);
  });

  it('returns retrieval reasons and budget metadata from retrieve endpoint', async () => {
    const { pipeline } = createWebFixture();

    await pipeline.ingest(
      'file',
      'export function retrieveContextDiagnostics() { return "budget"; }',
      'code',
      'src/web/diagnostics.ts',
      'typescript'
    );

    const response = await requestWeb(
      pipeline,
      `/api/retrieve?query=${encodeURIComponent('where is retrieveContextDiagnostics defined')}&mode=focused&maxTokens=8000`
    );
    expect(response.status).toBe(200);
    const result = response.json<{
      chunks: Array<{
        path?: string;
        retrievalReasons: string[];
        retrievalSources: string[];
        retrievalScores?: { final: number };
      }>;
      budget: number;
      hardBudget: number;
      targetBudget: number;
      utilization: number;
      plan: { strategy: string };
      selectionPolicy: { mode: string };
      omitted: Array<{ chunkId: string; reason: string }>;
      droppedCount: number;
      dropped: Array<{ chunkId: string; reason: string }>;
      compressedSummaries: Array<{ originalChunkId: string; tokensEstimate: number }>;
    }>();
    const selected = result.chunks.find((chunk) => chunk.path === 'src/web/diagnostics.ts');

    expect(result.budget).toBe(8000);
    expect(result.hardBudget).toBe(8000);
    expect(result.targetBudget).toBeGreaterThan(0);
    expect(result.utilization).toBeGreaterThanOrEqual(0);
    expect(result.plan.strategy).toBe('structural');
    expect(result.selectionPolicy.mode).toBe('focused');
    expect(selected?.retrievalSources).toContain('structural');
    expect(selected?.retrievalReasons.length).toBeGreaterThan(0);
    expect(selected?.retrievalScores?.final).toBeGreaterThan(0);
    expect(Array.isArray(result.omitted)).toBe(true);
    expect(result.droppedCount).toBe(result.dropped.length);
    expect(Array.isArray(result.dropped)).toBe(true);
    expect(Array.isArray(result.compressedSummaries)).toBe(true);
  });

  it('renders empty repository state and rejects invalid retrieve mode', async () => {
    const { pipeline } = createWebFixture();

    const page = await requestWeb(pipeline, '/');
    const chunks = requestWeb(pipeline, '/api/chunks').then((response) => response.json<unknown[]>());
    const invalidMode = await requestWeb(pipeline, '/api/retrieve?query=test&mode=everything');
    const invalidModeBody = invalidMode.json<{ error: string }>();
    const invalidBudget = await requestWeb(pipeline, '/api/retrieve?query=test&maxTokens=5abc');
    const invalidBudgetBody = invalidBudget.json<{ error: string }>();

    expect(page.body).toContain('id="empty-msg"');
    expect(page.body).toContain('No chunks ingested.');
    expect(await chunks).toEqual([]);
    expect(invalidMode.status).toBe(400);
    expect(invalidModeBody.error).toContain('mode must be one of');
    expect(invalidBudget.status).toBe(400);
    expect(invalidBudgetBody.error).toContain('maxTokens must be a positive integer');
  });

  it('returns direct errors for unsupported web methods and routes', async () => {
    const { pipeline } = createWebFixture();

    const wrongMethod = await requestWeb(pipeline, '/api/stats', 'POST');
    const wrongMethodBody = wrongMethod.json<{ error: string }>();
    const missingRoute = await requestWeb(pipeline, '/api/not-real');
    const missingRouteBody = missingRoute.json<{ error: string }>();

    expect(wrongMethod.status).toBe(405);
    expect(wrongMethodBody.error).toBe('Method not allowed');
    expect(missingRoute.status).toBe(404);
    expect(missingRouteBody.error).toBe('Not found');
  });
});
