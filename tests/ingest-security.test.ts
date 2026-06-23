import { afterEach, describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMCPServer } from '../src/mcp/server.js';
import { buildCLI } from '../src/cli/index.js';
import { createRepository } from '../src/storage/repository.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { ContextScorer } from '../src/core/scorer.js';
import { ContextRouter, DEFAULT_ROUTING_CONFIG } from '../src/core/router.js';
import { ContextIngester } from '../src/core/ingester.js';
import { DeterministicTokenEstimator } from '../src/providers/token-estimator.js';
import { DeterministicEmbeddingProvider } from '../src/providers/deterministic-embedding.js';
import { DeterministicCompressionProvider } from '../src/providers/deterministic-compression.js';
import { SimpleDependencyAnalyzer } from '../src/providers/dependency-analyzer.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

interface CallResult {
  isError?: boolean;
  text: string;
}

function createTestPipeline(): { pipeline: PipelineOrchestrator; dbPath: string } {
  const dbPath = join(tmpdir(), `sf-security-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

async function callIngestTool(
  pipeline: PipelineOrchestrator,
  name: string,
  args: Record<string, unknown>
): Promise<CallResult> {
  const server = createMCPServer(pipeline);
  const client = new Client({ name: 'sf-security-test', version: '0.0.0' });
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

const tempDirs: string[] = [];

function track<T extends string>(dir: T): T {
  tempDirs.push(dir);
  return dir;
}

// commander keeps _exitCallback per-Command; set it on the whole tree so a
// subcommand's cmd.error() throws (instead of process.exit) under test.
function exitOverrideTree(program: Command): void {
  program.exitOverride();
  for (const sub of program.commands) exitOverrideTree(sub);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('ingest-root allowlist — MCP boundary', () => {
  it('ingest_directory refuses a path outside the allowed roots', async () => {
    const { pipeline, dbPath } = createTestPipeline();
    try {
      const allowed = track(mkdtempSync(join(tmpdir(), 'sf-mcp-allow-')));
      const secret = track(mkdtempSync(join(tmpdir(), 'sf-mcp-secret-')));
      writeFileSync(join(secret, 'id_rsa'), 'TOPSECRET');
      process.env.SF_INGEST_ROOTS = allowed;

      const result = await callIngestTool(pipeline, 'ingest_directory', { path: secret });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('outside the allowed roots');
    } finally {
      delete process.env.SF_INGEST_ROOTS;
      pipeline.close();
      rmSync(dbPath, { force: true });
    }
  });

  it('ingest_project refuses a path outside the allowed roots', async () => {
    const { pipeline, dbPath } = createTestPipeline();
    try {
      const allowed = track(mkdtempSync(join(tmpdir(), 'sf-mcp-allow-')));
      const secret = track(mkdtempSync(join(tmpdir(), 'sf-mcp-secret-')));
      process.env.SF_INGEST_ROOTS = allowed;

      const result = await callIngestTool(pipeline, 'ingest_project', { path: secret });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('outside the allowed roots');
    } finally {
      delete process.env.SF_INGEST_ROOTS;
      pipeline.close();
      rmSync(dbPath, { force: true });
    }
  });

  it('ingest_directory succeeds for a path under an allowed root', async () => {
    const { pipeline, dbPath } = createTestPipeline();
    try {
      const allowed = track(mkdtempSync(join(tmpdir(), 'sf-mcp-ok-')));
      mkdirSync(join(allowed, 'src'), { recursive: true });
      writeFileSync(join(allowed, 'src', 'index.ts'), 'export const ok = true;');
      process.env.SF_INGEST_ROOTS = allowed;

      const result = await callIngestTool(pipeline, 'ingest_directory', { path: allowed });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text) as { files?: number };
      expect(parsed.files).toBeGreaterThanOrEqual(1);
    } finally {
      delete process.env.SF_INGEST_ROOTS;
      pipeline.close();
      rmSync(dbPath, { force: true });
    }
  });
});

describe('ingest-root allowlist — CLI boundary', () => {
  it('ingest command refuses a path outside the allowed roots', async () => {
    const allowed = track(mkdtempSync(join(tmpdir(), 'sf-cli-allow-')));
    const secret = track(mkdtempSync(join(tmpdir(), 'sf-cli-secret-')));
    writeFileSync(join(secret, 'id_rsa'), 'TOPSECRET');
    const dbPath = join(track(mkdtempSync(join(tmpdir(), 'sf-cli-db-'))), 'spacefolding.db');
    const previous = process.env.SF_INGEST_ROOTS;
    process.env.SF_INGEST_ROOTS = allowed;
    try {
      const cli = buildCLI();
      exitOverrideTree(cli);
      await expect(
        cli.parseAsync(['node', 'spacefolding', '--db', dbPath, 'ingest', secret])
      ).rejects.toThrow(/outside the allowed roots/);
    } finally {
      if (previous === undefined) delete process.env.SF_INGEST_ROOTS;
      else process.env.SF_INGEST_ROOTS = previous;
    }
  });

  it('ingest-project command refuses a path outside the allowed roots', async () => {
    const allowed = track(mkdtempSync(join(tmpdir(), 'sf-cli-allow-')));
    const secret = track(mkdtempSync(join(tmpdir(), 'sf-cli-secret-')));
    const dbPath = join(track(mkdtempSync(join(tmpdir(), 'sf-cli-db-'))), 'spacefolding.db');
    const previous = process.env.SF_INGEST_ROOTS;
    process.env.SF_INGEST_ROOTS = allowed;
    try {
      const cli = buildCLI();
      exitOverrideTree(cli);
      await expect(
        cli.parseAsync(['node', 'spacefolding', '--db', dbPath, 'ingest-project', secret])
      ).rejects.toThrow(/outside the allowed roots/);
    } finally {
      if (previous === undefined) delete process.env.SF_INGEST_ROOTS;
      else process.env.SF_INGEST_ROOTS = previous;
    }
  });
});
