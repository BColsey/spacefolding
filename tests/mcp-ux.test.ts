import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMCPServer, TOOL_DEFINITIONS } from '../src/mcp/server.js';
import { createRepository } from '../src/storage/repository.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { ContextScorer } from '../src/core/scorer.js';
import { ContextRouter, DEFAULT_ROUTING_CONFIG } from '../src/core/router.js';
import { ContextIngester } from '../src/core/ingester.js';
import { DeterministicTokenEstimator } from '../src/providers/token-estimator.js';
import { DeterministicEmbeddingProvider } from '../src/providers/deterministic-embedding.js';
import { DeterministicCompressionProvider } from '../src/providers/deterministic-compression.js';
import { SimpleDependencyAnalyzer } from '../src/providers/dependency-analyzer.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

function createEmptyPipeline(): { pipeline: PipelineOrchestrator; dbPath: string } {
  const dbPath = join(tmpdir(), `sf-mcpux-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

async function callTool(
  pipeline: PipelineOrchestrator,
  name: string,
  args: Record<string, unknown>
): Promise<{ isError?: boolean; text: string }> {
  const server = createMCPServer(pipeline);
  const client = new Client({ name: 'sf-mcpux-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const response = await client.callTool({ name, arguments: args });
    const textItem = response.content.find((item) => item.type === 'text');
    return { isError: response.isError, text: textItem?.text ?? '' };
  } finally {
    await client.close();
    await server.close();
  }
}

/** Queries the advertised ListTools surface (what an agent actually sees). */
async function listAdvertisedTools(
  pipeline: PipelineOrchestrator
): Promise<{ name: string; annotations?: Record<string, unknown> }[]> {
  const server = createMCPServer(pipeline);
  const client = new Client({ name: 'sf-mcpux-list-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.listTools();
    return result.tools.map((t) => ({ name: t.name, annotations: t.annotations as Record<string, unknown> | undefined }));
  } finally {
    await client.close();
    await server.close();
  }
}

describe('MCP tool annotations (readOnlyHint / destructiveHint)', () => {
  it('marks the read-only retrieval and inspection tools readOnlyHint=true', () => {
    const readOnly = [
      'retrieve_context',
      'iterative_retrieve',
      'get_relevant_memory',
      'explain_routing',
      'list_context',
    ];
    for (const name of readOnly) {
      const tool = TOOL_DEFINITIONS.find((def) => def.name === name);
      expect(tool, `tool ${name} should exist`).toBeDefined();
      expect(tool?.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('marks delete_context destructiveHint=true', () => {
    const tool = TOOL_DEFINITIONS.find((def) => def.name === 'delete_context');
    expect(tool?.annotations?.destructiveHint).toBe(true);
  });

  it('does not mark the mutating ingest tools as read-only', () => {
    const mutating = ['ingest_context', 'ingest_project', 'ingest_directory'];
    for (const name of mutating) {
      const tool = TOOL_DEFINITIONS.find((def) => def.name === name);
      expect(tool?.annotations?.readOnlyHint).not.toBe(true);
    }
  });
});

describe('MCP empty-index self-heal hint', () => {
  it('retrieve_context on an empty index returns an ingest hint instead of a bare envelope', async () => {
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      expect(pipeline.getStats().totalChunks).toBe(0);
      const result = await callTool(pipeline, 'retrieve_context', { query: 'anything relevant' });
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      expect(parsed.empty).toBe(true);
      expect(String(parsed.hint)).toMatch(/ingest/i);
      expect(Array.isArray(parsed.suggestedTools)).toBe(true);
      // Post-collapse the agent only sees the 4 canonical tools, so the hint
      // must steer to the canonical `ingest` tool (not the legacy names).
      expect((parsed.suggestedTools as unknown[])).toContain('ingest');
      expect((parsed.suggestedTools as unknown[])).not.toContain('ingest_project');
      expect((parsed.suggestedTools as unknown[])).not.toContain('ingest_directory');
    } finally {
      pipeline.close();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void dbPath;
    }
  });

  it('get_relevant_memory on an empty index returns an ingest hint', async () => {
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      const result = await callTool(pipeline, 'get_relevant_memory', {
        task: { text: 'anything' },
      });
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      expect(parsed.empty).toBe(true);
      expect(String(parsed.hint)).toMatch(/ingest/i);
    } finally {
      pipeline.close();
      void dbPath;
    }
  });

  it('iterative_retrieve on an empty index returns an ingest hint', async () => {
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      const result = await callTool(pipeline, 'iterative_retrieve', {
        query: 'anything relevant',
      });
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      expect(parsed.empty).toBe(true);
      expect(String(parsed.hint)).toMatch(/ingest/i);
      expect(Array.isArray(parsed.suggestedTools)).toBe(true);
    } finally {
      pipeline.close();
      void dbPath;
    }
  });
});

describe('MCP destructive annotations on mutating tools', () => {
  it('marks path-ingest and graph-mutating tools destructiveHint=true', () => {
    const destructive = ['ingest_project', 'ingest_directory', 'update_context_graph'];
    for (const name of destructive) {
      const tool = TOOL_DEFINITIONS.find((def) => def.name === name);
      expect(tool, `tool ${name} should exist`).toBeDefined();
      expect(tool?.annotations?.destructiveHint).toBe(true);
    }
  });
});

describe('retrieve_context explain/score flags', () => {
  it('exposes optional explain and score boolean params in the schema', () => {
    const retrieve = TOOL_DEFINITIONS.find((def) => def.name === 'retrieve_context');
    const props = retrieve?.inputSchema.properties as Record<string, { type?: string; description?: string }>;
    expect(props.explain?.type).toBe('boolean');
    expect(props.score?.type).toBe('boolean');
    expect(props.explain?.description).toContain('explain_routing');
    expect(props.score?.description).toContain('score_context');
  });

  it('explain=true folds a routingExplanation (per-chunk reasons + summary) into the response', async () => {
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      await pipeline.ingest('file', 'function explainScoreFlag() { return true; }', 'code', 'src/flags.ts', 'typescript');
      const result = await callTool(pipeline, 'retrieve_context', {
        query: 'explain score flag',
        explain: true,
      });
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      const explanation = parsed.routingExplanation as {
        routing?: Array<{ chunkId: string; tier: string; reasons: string[] }>;
        summary?: string;
      };
      expect(explanation).toBeDefined();
      expect(typeof explanation.summary).toBe('string');
      expect(Array.isArray(explanation.routing)).toBe(true);
      expect(explanation.routing!.length).toBeGreaterThan(0);
      expect(explanation.routing![0]).toHaveProperty('tier');
      expect(explanation.routing![0]).toHaveProperty('reasons');
    } finally {
      pipeline.close();
      void dbPath;
    }
  });

  it('score=true folds hot/warm/cold routing lists + scores into the response', async () => {
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      await pipeline.ingest('file', 'function scoreFlagHandler() { return "scored"; }', 'code', 'src/score.ts', 'typescript');
      const result = await callTool(pipeline, 'retrieve_context', {
        query: 'score flag handler',
        score: true,
      });
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      const routing = parsed.routing as {
        hot: string[];
        warm: string[];
        cold: string[];
        scores: Record<string, number>;
        reasons: Record<string, string[]>;
      };
      expect(routing).toBeDefined();
      expect(Array.isArray(routing.hot)).toBe(true);
      expect(Array.isArray(routing.warm)).toBe(true);
      expect(Array.isArray(routing.cold)).toBe(true);
      expect(typeof routing.scores).toBe('object');
      expect(typeof routing.reasons).toBe('object');
    } finally {
      pipeline.close();
      void dbPath;
    }
  });

  it('omits routingExplanation/routing when neither flag is set (default shape unchanged)', async () => {
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      await pipeline.ingest('file', 'function noFlagsDefault() { return 1; }', 'code', 'src/noop.ts', 'typescript');
      const result = await callTool(pipeline, 'retrieve_context', { query: 'no flags' });
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      expect(parsed.routingExplanation).toBeUndefined();
      expect(parsed.routing).toBeUndefined();
      expect(Array.isArray(parsed.chunks)).toBe(true);
    } finally {
      pipeline.close();
      void dbPath;
    }
  });
});

describe('canonical tool-surface collapse (WS2.2)', () => {
  it('ListTools advertises exactly the 4 canonical tools', async () => {
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      const advertised = await listAdvertisedTools(pipeline);
      const names = advertised.map((t) => t.name).sort();
      expect(names).toEqual(['get_context_for_task', 'get_relevant_memory', 'ingest', 'retrieve_context']);
    } finally {
      pipeline.close();
      void dbPath;
    }
  });

  it('does NOT advertise any of the 12 legacy names', async () => {
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      const advertised = await listAdvertisedTools(pipeline);
      const names = new Set(advertised.map((t) => t.name));
      const legacy = [
        'score_context', 'compress_context', 'ingest_context', 'update_context_graph',
        'explain_routing', 'iterative_retrieve', 'ingest_project', 'ingest_directory',
        'list_context', 'delete_context',
      ];
      for (const name of legacy) {
        expect(names.has(name), `legacy ${name} should NOT be advertised`).toBe(false);
      }
    } finally {
      pipeline.close();
      void dbPath;
    }
  });

  it('canonical tools carry correct annotations', async () => {
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      const advertised = await listAdvertisedTools(pipeline);
      const byName = Object.fromEntries(advertised.map((t) => [t.name, t.annotations]));
      expect(byName.retrieve_context?.readOnlyHint).toBe(true);
      expect(byName.get_relevant_memory?.readOnlyHint).toBe(true);
      expect(byName.get_context_for_task?.readOnlyHint).toBe(true);
      expect(byName.ingest?.destructiveHint).toBe(true);
    } finally {
      pipeline.close();
      void dbPath;
    }
  });
});

describe('legacy tool-name aliases remain callable via CallTool', () => {
  // Highest-priority invariant: every one of the 12 old names must still work.
  const legacyNames = [
    'score_context', 'compress_context', 'get_relevant_memory', 'ingest_context',
    'update_context_graph', 'explain_routing', 'retrieve_context', 'iterative_retrieve',
    'ingest_project', 'ingest_directory', 'list_context', 'delete_context',
  ];

  it('TOOL_NAMES gate accepts every legacy name (not rejected as Unknown tool)', async () => {
    // Minimal-but-valid args per tool, so each name passes the TOOL_NAMES gate
    // AND arg validation, reaches its dedicated handler, and is proven
    // dispatched (response is NOT the "Unknown tool" gate-rejection). Some
    // handlers succeed, some return arg-validation errors — both are fine; the
    // invariant under test is gate-acceptance + dispatch, not handler success.
    const allowed = mkdtempSync(join(tmpdir(), 'sf-alias-allow-'));
    writeFileSync(join(allowed, 'probe.ts'), 'export const probe = 1;');
    const prevRoots = process.env.SF_INGEST_ROOTS;
    process.env.SF_INGEST_ROOTS = allowed;
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      await pipeline.ingest('file', 'function aliasInvariant() { return true; }', 'code', 'src/alias.ts', 'typescript');
      const minimalArgs: Record<string, Record<string, unknown>> = {
        retrieve_context: { query: 'alias probe' },
        iterative_retrieve: { query: 'alias probe' },
        get_relevant_memory: { task: { text: 'alias probe' } },
        explain_routing: { task: { text: 'alias probe' } },
        score_context: { task: { text: 'alias probe' } },
        ingest_context: { source: 'test', text: 'alias probe content' },
        ingest_project: { path: allowed },
        ingest_directory: { path: allowed },
        list_context: {},
        delete_context: { chunkIds: ['nonexistent-chunk-id'] },
        compress_context: { task: { text: 'alias probe' }, chunkIds: ['nonexistent-chunk-id'] },
        update_context_graph: {
          chunkId: 'alias-probe-chunk',
          operation: 'add',
          dependencies: [{ fromId: 'a', toId: 'b', type: 'references' }],
        },
      };
      for (const name of legacyNames) {
        const args = minimalArgs[name];
        const result = await callTool(pipeline, name, args);
        const parsed = JSON.parse(result.text) as Record<string, unknown>;
        // The defining assertion: the name was recognized + dispatched. An
        // unrecognized name returns { error: "Unknown tool: <name>" }.
        expect(String(parsed.error ?? ''), `${name} must NOT be rejected as Unknown tool`).not.toContain('Unknown tool');
      }
    } finally {
      if (prevRoots === undefined) delete process.env.SF_INGEST_ROOTS;
      else process.env.SF_INGEST_ROOTS = prevRoots;
      pipeline.close();
      rmSync(dbPath, { force: true });
      rmSync(allowed, { recursive: true, force: true });
    }
  });

  it('an unknown tool name is still rejected as Unknown tool', async () => {
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      const result = await callTool(pipeline, 'definitely_not_a_tool', {});
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      expect(result.isError).toBe(true);
      expect(String(parsed.error)).toContain('Unknown tool');
    } finally {
      pipeline.close();
      void dbPath;
    }
  });
});

describe('unified ingest tool', () => {
  it('item mode ingests a single content string', async () => {
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      const result = await callTool(pipeline, 'ingest', {
        mode: 'item',
        content: 'function unifiedIngest() { return 42; }',
        type: 'code',
      });
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      expect(parsed.chunkId).toBeDefined();
      expect(parsed.mode).toBe('item');
      expect(pipeline.getStats().totalChunks).toBeGreaterThan(0);
    } finally {
      pipeline.close();
      void dbPath;
    }
  });

  it('auto mode with content defaults to item ingest', async () => {
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      const result = await callTool(pipeline, 'ingest', {
        content: 'auto-detected item content',
        type: 'fact',
      });
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      expect(parsed.mode).toBe('item');
      expect(parsed.chunkId).toBeDefined();
    } finally {
      pipeline.close();
      void dbPath;
    }
  });

  it('directory mode ingests an allowed path tree', async () => {
    const allowed = mkdtempSync(join(tmpdir(), 'sf-ingest-allow-'));
    writeFileSync(join(allowed, 'a.ts'), 'export const a = 1;');
    const { pipeline, dbPath } = createEmptyPipeline();
    const prevRoots = process.env.SF_INGEST_ROOTS;
    process.env.SF_INGEST_ROOTS = allowed;
    try {
      const result = await callTool(pipeline, 'ingest', { mode: 'directory', path: allowed });
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      expect(result.isError).not.toBe(true);
      expect(parsed.mode).toBe('directory');
      expect(pipeline.getStats().totalChunks).toBeGreaterThan(0);
    } finally {
      if (prevRoots === undefined) delete process.env.SF_INGEST_ROOTS;
      else process.env.SF_INGEST_ROOTS = prevRoots;
      pipeline.close();
      rmSync(dbPath, { force: true });
      rmSync(allowed, { recursive: true, force: true });
    }
  });

  it('path modes refuse a path outside the allowed roots', async () => {
    const allowed = mkdtempSync(join(tmpdir(), 'sf-ingest-allow-'));
    const secret = mkdtempSync(join(tmpdir(), 'sf-ingest-secret-'));
    writeFileSync(join(secret, 'id_rsa'), 'TOPSECRET');
    const { pipeline, dbPath } = createEmptyPipeline();
    const prevRoots = process.env.SF_INGEST_ROOTS;
    process.env.SF_INGEST_ROOTS = allowed;
    try {
      const result = await callTool(pipeline, 'ingest', { mode: 'directory', path: secret });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('outside the allowed roots');
      expect(pipeline.getStats().totalChunks).toBe(0);
    } finally {
      if (prevRoots === undefined) delete process.env.SF_INGEST_ROOTS;
      else process.env.SF_INGEST_ROOTS = prevRoots;
      pipeline.close();
      rmSync(dbPath, { force: true });
      rmSync(allowed, { recursive: true, force: true });
      rmSync(secret, { recursive: true, force: true });
    }
  });
});

describe('get_context_for_task composite', () => {
  it('empty index + no rootPath returns the self-heal hint', async () => {
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      expect(pipeline.getStats().totalChunks).toBe(0);
      const result = await callTool(pipeline, 'get_context_for_task', { task: 'anything' });
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      expect(parsed.empty).toBe(true);
      expect(String(parsed.hint)).toMatch(/ingest/i);
    } finally {
      pipeline.close();
      void dbPath;
    }
  });

  it('empty index + allowed rootPath ingests then retrieves', async () => {
    const allowed = mkdtempSync(join(tmpdir(), 'sf-gcft-allow-'));
    writeFileSync(join(allowed, 'feature.ts'), 'export function compositeFeature() { return "ready"; }');
    const { pipeline, dbPath } = createEmptyPipeline();
    const prevRoots = process.env.SF_INGEST_ROOTS;
    process.env.SF_INGEST_ROOTS = allowed;
    try {
      expect(pipeline.getStats().totalChunks).toBe(0);
      const result = await callTool(pipeline, 'get_context_for_task', {
        task: 'composite feature',
        rootPath: allowed,
      });
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      // After ingest-then-retrieve, we should have chunks (not the empty hint).
      expect(parsed.empty).not.toBe(true);
      expect(Array.isArray(parsed.chunks)).toBe(true);
      expect((parsed.chunks as unknown[]).length).toBeGreaterThan(0);
      expect(parsed.totalTokens).toBeDefined();
    } finally {
      if (prevRoots === undefined) delete process.env.SF_INGEST_ROOTS;
      else process.env.SF_INGEST_ROOTS = prevRoots;
      pipeline.close();
      rmSync(dbPath, { force: true });
      rmSync(allowed, { recursive: true, force: true });
    }
  });

  it('empty index + disallowed rootPath is refused (never ingests outside roots)', async () => {
    const allowed = mkdtempSync(join(tmpdir(), 'sf-gcft-allow-'));
    const secret = mkdtempSync(join(tmpdir(), 'sf-gcft-secret-'));
    writeFileSync(join(secret, 'id_rsa'), 'TOPSECRET');
    const { pipeline, dbPath } = createEmptyPipeline();
    const prevRoots = process.env.SF_INGEST_ROOTS;
    process.env.SF_INGEST_ROOTS = allowed;
    try {
      const result = await callTool(pipeline, 'get_context_for_task', {
        task: 'anything',
        rootPath: secret,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('outside the allowed roots');
      expect(pipeline.getStats().totalChunks).toBe(0);
    } finally {
      if (prevRoots === undefined) delete process.env.SF_INGEST_ROOTS;
      else process.env.SF_INGEST_ROOTS = prevRoots;
      pipeline.close();
      rmSync(dbPath, { force: true });
      rmSync(allowed, { recursive: true, force: true });
      rmSync(secret, { recursive: true, force: true });
    }
  });

  it('populated index retrieves without re-ingesting', async () => {
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      await pipeline.ingest('file', 'function alreadyIngested() { return true; }', 'code', 'src/pop.ts', 'typescript');
      const before = pipeline.getStats().totalChunks;
      const result = await callTool(pipeline, 'get_context_for_task', { task: 'already ingested' });
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      expect(parsed.empty).not.toBe(true);
      expect(Array.isArray(parsed.chunks)).toBe(true);
      // No re-ingest: chunk count unchanged.
      expect(pipeline.getStats().totalChunks).toBe(before);
    } finally {
      pipeline.close();
      void dbPath;
    }
  });

  it('returns the same diagnostics fields as retrieve_context (composite parity)', async () => {
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      await pipeline.ingest('file', 'function compositeParity() { return "diag"; }', 'code', 'src/parity.ts', 'typescript');
      const result = await callTool(pipeline, 'get_context_for_task', { task: 'composite parity diagnostics' });
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      // Flagship composite must mirror retrieve_context's response richness.
      expect(parsed.task).toBe('composite parity diagnostics');
      expect(parsed.omittedCount).toBeDefined();
      expect(Array.isArray(parsed.omitted)).toBe(true);
      expect(parsed.droppedCount).toBeDefined();
      expect(Array.isArray(parsed.dropped)).toBe(true);
      expect(parsed.compressedCount).toBeDefined();
      expect(Array.isArray(parsed.compressedSummaries)).toBe(true);
      expect(parsed.selectionPolicy).toBeDefined();
      // Per-chunk retrieval diagnostics present on each chunk.
      const chunks = parsed.chunks as Array<Record<string, unknown>>;
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].retrievalSources).toBeDefined();
      expect(chunks[0].retrievalReasons).toBeDefined();
    } finally {
      pipeline.close();
      void dbPath;
    }
  });

  it('passes topK/returnLimit/maxHops through to retrieve (no validation error)', async () => {
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      await pipeline.ingest('file', 'function parityParams() { return 1; }', 'code', 'src/pp.ts', 'typescript');
      const result = await callTool(pipeline, 'get_context_for_task', {
        task: 'parity params',
        topK: 5,
        returnLimit: 3,
        maxHops: 0,
      });
      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      expect(parsed.empty).not.toBe(true);
      expect(Array.isArray(parsed.chunks)).toBe(true);
    } finally {
      pipeline.close();
      void dbPath;
    }
  });
});

describe('unified ingest auto-mode empty-string routing', () => {
  it('content:"" with a valid path routes to directory ingest (not the item error path)', async () => {
    const allowed = mkdtempSync(join(tmpdir(), 'sf-ingest-empty-allow-'));
    writeFileSync(join(allowed, 'a.ts'), 'export const a = 1;');
    const { pipeline, dbPath } = createEmptyPipeline();
    const prevRoots = process.env.SF_INGEST_ROOTS;
    process.env.SF_INGEST_ROOTS = allowed;
    try {
      const result = await callTool(pipeline, 'ingest', {
        mode: 'auto',
        content: '',
        path: allowed,
      });
      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      // Routed to directory ingest (empty content did NOT claim the item branch).
      expect(parsed.mode).toBe('directory');
      expect(pipeline.getStats().totalChunks).toBeGreaterThan(0);
    } finally {
      if (prevRoots === undefined) delete process.env.SF_INGEST_ROOTS;
      else process.env.SF_INGEST_ROOTS = prevRoots;
      pipeline.close();
      rmSync(dbPath, { force: true });
      rmSync(allowed, { recursive: true, force: true });
    }
  });
});
