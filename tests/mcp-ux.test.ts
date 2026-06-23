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
});
