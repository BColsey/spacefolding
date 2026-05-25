import { afterEach, describe, expect, it, vi } from 'vitest';
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
  vi.restoreAllMocks();
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

  it('retrieve command max-hops option describes graph strategy defaulting', () => {
    const cli = buildCLI();
    const retrieve = cli.commands.find((command) => command.name() === 'retrieve');
    const maxHopsOpt = retrieve?.options.find((option) => option.long === '--max-hops');

    expect(maxHopsOpt?.defaultValue).toBeUndefined();
    expect(maxHopsOpt?.description).toContain('default: 1 for graph strategy');
    expect(maxHopsOpt?.description).toContain('0 otherwise');
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

  it('leaves max-hops unset when the retrieve command does not specify it', () => {
    const parsed = parseRetrieveCommandOptions({
      query: 'find auth',
    });

    expect(parsed.error).toBeUndefined();
    expect(parsed.options?.maxHops).toBeUndefined();
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

  it('retrieve command output includes retrieval token usage metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spacefolding-cli-test-'));
    const dbPath = join(dir, 'spacefolding.db');
    const originalEmbeddingProvider = process.env.EMBEDDING_PROVIDER;
    process.env.EMBEDDING_PROVIDER = 'deterministic';

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const cli = buildCLI();
      cli.exitOverride();
      await cli.parseAsync([
        'node',
        'spacefolding',
        '--db',
        dbPath,
        'retrieve',
        '--query',
        'where is retrieve command output',
        '--max-tokens',
        '8000',
        '--mode',
        'focused',
      ]);

      const output = log.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(output).toContain('Query: where is retrieve command output');
      expect(output).toContain('Intent:');
      expect(output).toContain('Mode: focused');
      expect(output).toMatch(/Tokens: \d+\/\d+ target \(8000 hard cap\)/);
    } finally {
      if (originalEmbeddingProvider === undefined) {
        delete process.env.EMBEDDING_PROVIDER;
      } else {
        process.env.EMBEDDING_PROVIDER = originalEmbeddingProvider;
      }
      rmSync(dir, { recursive: true, force: true });
    }
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
    expect(props.maxHops?.description).toContain('default: 1 for graph strategy');
    expect(props.maxHops?.description).toContain('0 otherwise');
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
    expect(validateArgs({}, 'retrieve_context')).toContain('query must be a non-empty string');
    expect(validateArgs(undefined, 'iterative_retrieve')).toContain('query must be a non-empty string');
  });

  it('validates MCP required arguments by tool without rejecting no-arg tools', () => {
    expect(validateArgs(undefined, 'list_context')).toBeUndefined();
    expect(validateArgs({}, 'ingest_project')).toContain('path must be a non-empty string');
    expect(validateArgs({}, 'delete_context')).toContain('chunkIds must be a non-empty array');
    expect(validateArgs({ chunkIds: ['valid', ''] }, 'delete_context')).toContain(
      'chunkIds must contain non-empty strings'
    );
    expect(validateArgs({}, 'score_context')).toContain('task must be an object with text string');
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

  it('passes retrieval strategy and candidate controls from retrieve endpoint', async () => {
    const retrieve = vi.fn().mockResolvedValue({
      chunks: [],
      tiers: new Map<string, string>(),
      totalTokens: 0,
      budget: 6000,
      hardBudget: 6000,
      targetBudget: 6000,
      utilization: 0,
      omitted: [],
      dropped: [],
      compressed: [],
      plan: { intent: 'code_search', strategy: 'text' },
      retrieval: [],
      selectionPolicy: { mode: 'broad' },
    });
    const pipeline = { retrieve } as unknown as PipelineOrchestrator;

    const response = await requestWeb(
      pipeline,
      '/api/retrieve?query=find%20auth&strategy=text&mode=broad&maxTokens=6000&topK=9&returnLimit=4&maxHops=2'
    );

    expect(response.status).toBe(200);
    expect(retrieve).toHaveBeenCalledWith('find auth', 6000, {
      strategy: 'text',
      mode: 'broad',
      topK: 9,
      returnLimit: 4,
      maxHops: 2,
    });
  });

  it('renders empty repository state and rejects invalid retrieve mode', async () => {
    const { pipeline } = createWebFixture();

    const page = await requestWeb(pipeline, '/');
    const chunks = requestWeb(pipeline, '/api/chunks').then((response) => response.json<unknown[]>());
    const invalidMode = await requestWeb(pipeline, '/api/retrieve?query=test&mode=everything');
    const invalidModeBody = invalidMode.json<{ error: string }>();
    const invalidBudget = await requestWeb(pipeline, '/api/retrieve?query=test&maxTokens=5abc');
    const invalidBudgetBody = invalidBudget.json<{ error: string }>();
    const invalidStrategy = await requestWeb(pipeline, '/api/retrieve?query=test&strategy=keyword');
    const invalidStrategyBody = invalidStrategy.json<{ error: string }>();
    const invalidTopK = await requestWeb(pipeline, '/api/retrieve?query=test&topK=1.5');
    const invalidTopKBody = invalidTopK.json<{ error: string }>();
    const invalidReturnLimit = await requestWeb(pipeline, '/api/retrieve?query=test&returnLimit=0');
    const invalidReturnLimitBody = invalidReturnLimit.json<{ error: string }>();
    const invalidMaxHops = await requestWeb(pipeline, '/api/retrieve?query=test&maxHops=-1');
    const invalidMaxHopsBody = invalidMaxHops.json<{ error: string }>();

    expect(page.body).toContain('id="empty-msg"');
    expect(page.body).toContain('No chunks ingested.');
    expect(await chunks).toEqual([]);
    expect(invalidMode.status).toBe(400);
    expect(invalidModeBody.error).toContain('mode must be one of');
    expect(invalidBudget.status).toBe(400);
    expect(invalidBudgetBody.error).toContain('maxTokens must be a positive integer');
    expect(invalidStrategy.status).toBe(400);
    expect(invalidStrategyBody.error).toContain('strategy must be one of');
    expect(invalidTopK.status).toBe(400);
    expect(invalidTopKBody.error).toContain('topK must be a positive integer');
    expect(invalidReturnLimit.status).toBe(400);
    expect(invalidReturnLimitBody.error).toContain('returnLimit must be a positive integer');
    expect(invalidMaxHops.status).toBe(400);
    expect(invalidMaxHopsBody.error).toContain('maxHops must be a non-negative integer');
  });

  it('escapes client-rendered chunk table values before inserting HTML', async () => {
    const { pipeline } = createWebFixture();

    const page = await requestWeb(pipeline, '/');

    expect(page.body).toContain('escapeHtml(chunk.path||chunk.source||\'\')');
    expect(page.body).toContain('escapeHtml(chunk.type)');
    expect(page.body).toContain('escapeHtml(chunk.tokensEstimate||0)');
    expect(page.body).toContain('escapeHtml(trim(chunk.text.replace');
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
