import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runInit,
  buildServerEntry,
  readExistingMcpJson,
  mergeServerEntry,
} from '../src/cli/commands/init.js';
import { buildCLI } from '../src/cli/index.js';
import { Command } from 'commander';

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const PREWARMED: Record<string, string> = { called: 'no', modelId: '' };

function fakePrewarm(modelId: string): Promise<void> {
  PREWARMED.called = 'yes';
  PREWARMED.modelId = modelId;
  return Promise.resolve();
}

describe('init: .mcp.json server entry builder', () => {
  it('npx form has the expected machine-agnostic shape', () => {
    expect(buildServerEntry('npx', '/irrelevant/main.js')).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'spacefolding', 'serve'],
    });
  });

  it('local form points at the dist main.js', () => {
    expect(buildServerEntry('local', '/abs/path/dist/main.js')).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['/abs/path/dist/main.js', 'serve'],
    });
  });
});

describe('init: readExistingMcpJson + mergeServerEntry', () => {
  it('returns null when the file is absent', () => {
    expect(readExistingMcpJson('/nonexistent/.mcp.json')).toEqual({ parsed: null, hasSpacefolding: false });
  });

  it('detects an existing spacefolding entry, preserving siblings', () => {
    const parsed = { mcpServers: { spacefolding: { command: 'old' }, other: { command: 'x' } } };
    // (file IO tested elsewhere; here we test merge directly)
    const merged = mergeServerEntry(parsed, buildServerEntry('npx', '/x/main.js'));
    const servers = merged.mcpServers as Record<string, unknown>;
    expect(servers.spacefolding).toEqual(buildServerEntry('npx', '/x/main.js'));
    expect(servers.other).toEqual({ command: 'x' }); // sibling preserved
  });

  it('merge creates mcpServers when absent, preserving top-level keys', () => {
    const parsed = { description: 'my project' };
    const merged = mergeServerEntry(parsed, buildServerEntry('npx', '/x/main.js'));
    expect(merged.description).toBe('my project');
    expect((merged.mcpServers as Record<string, unknown>).spacefolding).toBeDefined();
  });

  it('merge handles a null parsed (fresh file)', () => {
    const merged = mergeServerEntry(null, buildServerEntry('npx', '/x/main.js'));
    expect((merged.mcpServers as Record<string, unknown>).spacefolding).toBeDefined();
  });
});

describe('init: runInit writes valid machine-agnostic .mcp.json', () => {
  let dir: string;
  const prevProvider = process.env.EMBEDDING_PROVIDER;

  beforeEach(() => {
    dir = tmpDir('sf-init-');
    PREWARMED.called = 'no';
    PREWARMED.modelId = '';
    delete process.env.EMBEDDING_PROVIDER;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevProvider === undefined) delete process.env.EMBEDDING_PROVIDER;
    else process.env.EMBEDDING_PROVIDER = prevProvider;
  });

  it('writes the npx form by default and pre-warms the default model', async () => {
    const result = await runInit({ cwd: dir, prewarmModel: fakePrewarm, silent: true });

    expect(result.mcpJsonForm).toBe('npx');
    expect(result.prewarmed).toBe(true);
    expect(PREWARMED.called).toBe('yes');
    expect(PREWARMED.modelId).toBe('Xenova/bge-small-en-v1.5');

    const written = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8'));
    expect(written.mcpServers.spacefolding).toEqual(buildServerEntry('npx', '/x'));
    expect(written.mcpServers.spacefolding.command).toBe('npx');
    expect(written.mcpServers.spacefolding.args).toEqual(['-y', 'spacefolding', 'serve']);
    // No MODEL_PATH / DB_PATH keys — machine-agnostic.
    expect(written.mcpServers.spacefolding.env).toBeUndefined();
  });

  it('--local writes the local dist-path form', async () => {
    const result = await runInit({ cwd: dir, local: true, prewarmModel: fakePrewarm, silent: true });
    expect(result.mcpJsonForm).toBe('local');
    const written = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8'));
    expect(written.mcpServers.spacefolding.command).toBe('node');
    expect(written.mcpServers.spacefolding.args[0]).toMatch(/main\.js$/);
    expect(written.mcpServers.spacefolding.args[1]).toBe('serve');
  });

  it('is idempotent: re-run updates the spacefolding entry, no duplicate', async () => {
    await runInit({ cwd: dir, prewarmModel: fakePrewarm, silent: true });
    await runInit({ cwd: dir, prewarmModel: fakePrewarm, silent: true });
    const written = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8'));
    const servers = Object.keys(written.mcpServers);
    expect(servers.filter((s) => s === 'spacefolding')).toHaveLength(1);
  });

  it('merges into an existing .mcp.json with other servers + top-level keys', async () => {
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ description: 'pre-existing', mcpServers: { filesystem: { command: 'npx' } } }),
    );
    await runInit({ cwd: dir, prewarmModel: fakePrewarm, silent: true });
    const written = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8'));
    expect(written.description).toBe('pre-existing');
    expect(written.mcpServers.filesystem).toEqual({ command: 'npx' }); // preserved
    expect(written.mcpServers.spacefolding.command).toBe('npx'); // added
  });

  it('skips model pre-warm when EMBEDDING_PROVIDER=deterministic', async () => {
    process.env.EMBEDDING_PROVIDER = 'deterministic';
    const result = await runInit({ cwd: dir, prewarmModel: fakePrewarm, silent: true });
    expect(result.prewarmed).toBe(false);
    expect(result.providerName).toBe('deterministic');
    expect(PREWARMED.called).toBe('no'); // prewarm never invoked
    // Still writes .mcp.json
    expect(existsSync(join(dir, '.mcp.json'))).toBe(true);
  });

  it('does not hard-fail when pre-warm throws (embed retries lazily)', async () => {
    const failPrewarm = (): Promise<void> => Promise.reject(new Error('network down'));
    const result = await runInit({ cwd: dir, prewarmModel: failPrewarm, silent: true });
    expect(result.prewarmed).toBe(false);
    expect(existsSync(join(dir, '.mcp.json'))).toBe(true); // config still written
  });

  it('ensures the per-project data dir exists', async () => {
    await runInit({ cwd: dir, prewarmModel: fakePrewarm, silent: true });
    expect(existsSync(join(dir, 'data'))).toBe(true);
  });
});

describe('init: CLI dispatch (not swallowed by serve-default)', () => {
  it('init is a registered commander command', () => {
    const program = buildCLI();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('init');
  });

  it('init appears early in --help (before ingest)', () => {
    const program = buildCLI();
    const names = program.commands.map((c) => c.name());
    const initIdx = names.indexOf('init');
    const ingestIdx = names.indexOf('ingest');
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(ingestIdx).toBeGreaterThanOrEqual(0);
    expect(initIdx).toBeLessThan(ingestIdx);
  });

  it('knownCommands in src/main.ts includes init (serve-default shim)', () => {
    // Directly exercise the shim's knownCommands membership rule by reading
    // the source — the runtime contract is "init must be in the list or it is
    // swallowed". Asserting at the source level keeps the test offline + fast.
    const src = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf-8');
    expect(src).toMatch(/'init'/);
  });
});
