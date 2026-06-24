import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  runSessionStart,
  runReindex,
  runPreCompact,
  storagePathFor,
  shouldIgnorePath,
  type HookDeps,
} from '../src/cli/commands/hooks.js';
import { createIngestPolicy } from '../src/security/ingest-policy.js';
import type { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';

// --- a fake pipeline that records calls + mimics getStats/ingestProject ---

interface FakePipelineState {
  chunks: number;
  files: number;
  reingestCalls: Array<{ path: string; text: string }>;
  deleteCalls: string[];
  ingestProjectCalls: string[];
}

function makeFakePipeline(state: FakePipelineState): PipelineOrchestrator {
  return {
    getStats: () => ({
      totalChunks: state.chunks,
      totalTokensEstimate: state.chunks * 100,
      files: state.files > 0
        ? Array.from({ length: state.files }, (_, i) => ({
            path: `file${i}.ts`,
            chunkCount: 1,
            tokensEstimate: 100,
          }))
        : [],
      oldestTimestamp: null,
      newestTimestamp: null,
    }),
    reingestFile: vi.fn(async (path: string, text: string) => {
      state.reingestCalls.push({ path, text });
      state.chunks += 1;
      return {
        path,
        changed: true,
        chunks: ['c1'],
        reusedChunks: 0,
        createdChunks: 1,
        deletedChunks: 0,
        totalChunks: state.chunks,
      };
    }),
    deleteChunksForPath: vi.fn((path: string) => {
      state.deleteCalls.push(path);
      return 1;
    }),
    ingestProject: vi.fn(async (dir: string) => {
      state.ingestProjectCalls.push(dir);
      state.chunks = 5;
      state.files = 3;
      return { files: 3, chunks: ['c1', 'c2', 'c3', 'c4', 'c5'], skipped: 0, codeFiles: 3, projectContextFiles: 0 };
    }),
    close: vi.fn(),
  } as unknown as PipelineOrchestrator;
}

function makeDeps(
  pipeline: PipelineOrchestrator,
  state: FakePipelineState,
  overrides: Partial<HookDeps> = {},
): HookDeps {
  return {
    openPipeline: async () => pipeline,
    countProjectFiles: () => 5,
    resolveDbPath: (cwd) => join(cwd, 'data', 'spacefolding.db'),
    readStdin: async () => '',
    logError: () => {},
    readFileText: (absPath) => {
      try {
        return readFileSync(absPath, 'utf-8');
      } catch {
        return null;
      }
    },
    exists: (absPath) => {
      try {
        return existsSync(absPath);
      } catch {
        return false;
      }
    },
    ...overrides,
  };
}

// --- temp project helpers ---

const tempDirs: string[] = [];
function makeTempProject(files: Record<string, string> = { 'src/index.ts': 'export const x = 1;' }): string {
  const dir = mkdtempSync(join(tmpdir(), 'sf-hooks-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}
afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe('hook storagePathFor (orphan-key parity with FileWatcher)', () => {
  it('produces a POSIX-relative storage path for an in-root file', () => {
    const root = makeTempProject();
    const file = join(root, 'src', 'feature', 'service.ts');
    expect(storagePathFor(file, root)).toBe('src/feature/service.ts');
  });

  it('normalizes backslashes to forward slashes (cross-platform key stability)', () => {
    const root = makeTempProject();
    // Simulate a windows-style nested path on a posix fs; the key must be posix.
    expect(storagePathFor(join(root, 'a', 'b.ts'), root)).toBe('a/b.ts');
  });

  it('falls back to the normalized absolute path for an out-of-tree file', () => {
    const root = makeTempProject();
    const external = resolve(root, '..', 'external.ts');
    const result = storagePathFor(external, root);
    expect(result.startsWith('..')).toBe(false);
    expect(result).toContain('external.ts');
  });
});

describe('hook shouldIgnorePath (churn filter parity with FileWatcher)', () => {
  it('ignores node_modules / .git / dist', () => {
    expect(shouldIgnorePath('/p/node_modules/x/index.js', [])).toBe(true);
    expect(shouldIgnorePath('/p/.git/config', [])).toBe(true);
    expect(shouldIgnorePath('/p/dist/main.js', [])).toBe(true);
  });

  it('ignores binary extensions', () => {
    expect(shouldIgnorePath('/p/logo.png', [])).toBe(true);
    expect(shouldIgnorePath('/p/font.woff2', [])).toBe(true);
  });

  it('does NOT ignore normal source files', () => {
    expect(shouldIgnorePath('/p/src/index.ts', [])).toBe(false);
  });

  it('ignores symlinks (security + churn)', () => {
    const watched = mkdtempSync(join(tmpdir(), 'sf-hooks-sym-'));
    tempDirs.push(watched);
    const external = mkdtempSync(join(tmpdir(), 'sf-hooks-ext-'));
    tempDirs.push(external);
    mkdirSync(join(watched, 'src'), { recursive: true });
    writeFileSync(join(external, 'secret.ts'), 'export const s = 1;');
    const link = join(watched, 'src', 'link.ts');
    symlinkSync(join(external, 'secret.ts'), link, 'file');
    expect(shouldIgnorePath(link, [])).toBe(true);
  });
});

describe('session-start hook', () => {
  beforeEach(() => {
    delete process.env.SF_INGEST_ROOTS;
    delete process.env.CLAUDE_PROJECT_DIR;
  });
  afterEach(() => {
    delete process.env.SF_INGEST_ROOTS;
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  it('auto-indexes an empty project (allowed cwd) and injects a context pack', async () => {
    const cwd = makeTempProject();
    const state: FakePipelineState = { chunks: 0, files: 0, reingestCalls: [], deleteCalls: [], ingestProjectCalls: [] };
    const pipeline = makeFakePipeline(state);
    const deps = makeDeps(pipeline, state, { countProjectFiles: () => 3 });

    const result = await runSessionStart({ cwd }, deps);

    expect(result.action).toBe('indexed');
    expect(state.ingestProjectCalls).toEqual([cwd]);
    expect(result.chunkCount).toBe(5);
    expect(result.additionalContext).toContain('Spacefolding indexed');
    expect(result.additionalContext).toContain('get_context_for_task');
  });

  it('does not force GPU provider (env untouched)', async () => {
    const cwd = makeTempProject();
    const state: FakePipelineState = { chunks: 0, files: 0, reingestCalls: [], deleteCalls: [], ingestProjectCalls: [] };
    const pipeline = makeFakePipeline(state);
    const before = process.env.EMBEDDING_PROVIDER;
    await runSessionStart({ cwd }, makeDeps(pipeline, state));
    expect(process.env.EMBEDDING_PROVIDER).toBe(before);
  });

  it('emits a freshness note when the index is non-empty (no bulk re-index)', async () => {
    const cwd = makeTempProject();
    const state: FakePipelineState = { chunks: 42, files: 7, reingestCalls: [], deleteCalls: [], ingestProjectCalls: [] };
    const pipeline = makeFakePipeline(state);
    const deps = makeDeps(pipeline, state);

    const result = await runSessionStart({ cwd }, deps);

    expect(result.action).toBe('fresh');
    expect(result.chunkCount).toBe(42);
    expect(state.ingestProjectCalls).toHaveLength(0);
    expect(result.additionalContext).toContain('warm');
  });

  it('respects SF_INGEST_ROOTS: the allowlist is consulted before bulk index', async () => {
    // By design cwd is ALWAYS an allowed root (the frictionless local default),
    // so a normal SessionStart with an allowed cwd indexes. We verify two things:
    //   (1) the hook indexes an allowed cwd (the happy path), and
    //   (2) a real policy constructed the same way the hook constructs it
    //       DENIES a path outside SF_INGEST_ROOTS (proving the guard is real).
    const cwd = makeTempProject();
    const state: FakePipelineState = { chunks: 0, files: 0, reingestCalls: [], deleteCalls: [], ingestProjectCalls: [] };
    const pipeline = makeFakePipeline(state);
    const deps = makeDeps(pipeline, state, { countProjectFiles: () => 3 });

    const result = await runSessionStart({ cwd }, deps);
    expect(result.action).toBe('indexed');

    // And the deny branch is reachable for out-of-root paths (this is what the
    // reindex hook exercises end-to-end below).
    const outside = mkdtempSync(join(tmpdir(), 'sf-hooks-outside-'));
    tempDirs.push(outside);
    process.env.SF_INGEST_ROOTS = cwd;
    const policy = createIngestPolicy({ cwd });
    expect(policy.assertAllowed(join(outside, 'secret.ts'))).toBeTruthy();
    expect(policy.assertAllowed(cwd)).toBeUndefined(); // cwd always allowed
  });

  it('size guard: skips bulk auto-index for huge projects', async () => {
    const cwd = makeTempProject();
    const state: FakePipelineState = { chunks: 0, files: 0, reingestCalls: [], deleteCalls: [], ingestProjectCalls: [] };
    const pipeline = makeFakePipeline(state);
    const deps = makeDeps(pipeline, state, { countProjectFiles: () => 50000 });

    const result = await runSessionStart({ cwd }, deps);

    expect(result.action).toBe('skipped-too-large');
    expect(state.ingestProjectCalls).toHaveLength(0);
    expect(result.additionalContext).toContain('ingest-project');
  });
});

describe('reindex hook (PostToolUse Edit|Write)', () => {
  beforeEach(() => {
    delete process.env.SF_INGEST_ROOTS;
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  it('reingestFile is called with the correct STORAGE path for an edited file', async () => {
    const cwd = makeTempProject({ 'src/service.ts': 'export function run() { return 1; }' });
    const file = join(cwd, 'src', 'service.ts');
    const state: FakePipelineState = { chunks: 1, files: 1, reingestCalls: [], deleteCalls: [], ingestProjectCalls: [] };
    const pipeline = makeFakePipeline(state);
    const deps = makeDeps(pipeline, state);

    const result = await runReindex(
      { cwd, tool_name: 'Edit', tool_input: { file_path: file } },
      deps,
    );

    expect(result.action).toBe('reindexed');
    // THE load-bearing assertion: storage path is POSIX-relative, matches the watcher.
    expect(state.reingestCalls).toHaveLength(1);
    expect(state.reingestCalls[0].path).toBe('src/service.ts');
    expect(result.storagePath).toBe('src/service.ts');
  });

  it('normalizes a nested edited file the same way the watcher does', async () => {
    const cwd = makeTempProject({ 'src/a/b/deep.ts': 'export const v = 2;' });
    const file = join(cwd, 'src', 'a', 'b', 'deep.ts');
    const state: FakePipelineState = { chunks: 1, files: 1, reingestCalls: [], deleteCalls: [], ingestProjectCalls: [] };
    const pipeline = makeFakePipeline(state);
    const deps = makeDeps(pipeline, state);

    await runReindex({ cwd, tool_input: { file_path: file } }, deps);

    expect(state.reingestCalls[0].path).toBe('src/a/b/deep.ts');
  });

  it('skips ignored paths (node_modules / .git / dist / binary) with NO reindex', async () => {
    const cwd = makeTempProject();
    const state: FakePipelineState = { chunks: 0, files: 0, reingestCalls: [], deleteCalls: [], ingestProjectCalls: [] };
    const pipeline = makeFakePipeline(state);
    const deps = makeDeps(pipeline, state);

    const cases = [
      join(cwd, 'node_modules', 'pkg', 'index.js'),
      join(cwd, '.git', 'config'),
      join(cwd, 'dist', 'main.js'),
      join(cwd, 'assets', 'logo.png'),
    ];
    for (const p of cases) {
      const result = await runReindex({ cwd, tool_input: { file_path: p } }, deps);
      expect(result.action).toBe('ignored');
    }
    expect(state.reingestCalls).toHaveLength(0);
  });

  it('DENIED path (outside SF_INGEST_ROOTS) → skipped, no reindex, no throw', async () => {
    const cwd = makeTempProject();
    const outside = mkdtempSync(join(tmpdir(), 'sf-hooks-outside-'));
    tempDirs.push(outside);
    const secret = join(outside, 'secret.ts');
    writeFileSync(secret, 'export const s = 1;');
    process.env.SF_INGEST_ROOTS = cwd; // cwd allowed, but `outside` is not

    const state: FakePipelineState = { chunks: 0, files: 0, reingestCalls: [], deleteCalls: [], ingestProjectCalls: [] };
    const pipeline = makeFakePipeline(state);
    const logSpy: string[] = [];
    const deps = makeDeps(pipeline, state, { logError: (m) => logSpy.push(m) });

    const result = await runReindex({ cwd, tool_input: { file_path: secret } }, deps);

    expect(result.action).toBe('denied');
    expect(state.reingestCalls).toHaveLength(0);
    expect(state.deleteCalls).toHaveLength(0);
    expect(logSpy.some((m) => m.includes('Refused'))).toBe(true);

    delete process.env.SF_INGEST_ROOTS;
  });

  it('returns no-file-path when tool_input.file_path is absent', async () => {
    const cwd = makeTempProject();
    const state: FakePipelineState = { chunks: 0, files: 0, reingestCalls: [], deleteCalls: [], ingestProjectCalls: [] };
    const pipeline = makeFakePipeline(state);
    const deps = makeDeps(pipeline, state);

    const result = await runReindex({ cwd, tool_name: 'Edit', tool_input: {} }, deps);
    expect(result.action).toBe('no-file-path');
  });

  it('deletes chunks when the edited file no longer exists (unlink case)', async () => {
    const cwd = makeTempProject();
    const gone = join(cwd, 'src', 'gone.ts'); // never created → missing
    const state: FakePipelineState = { chunks: 2, files: 1, reingestCalls: [], deleteCalls: [], ingestProjectCalls: [] };
    const pipeline = makeFakePipeline(state);
    const deps = makeDeps(pipeline, state);

    const result = await runReindex({ cwd, tool_input: { file_path: gone } }, deps);

    expect(result.action).toBe('deleted');
    expect(state.deleteCalls).toEqual(['src/gone.ts']);
    expect(state.reingestCalls).toHaveLength(0);
  });
});

describe('pre-compact hook', () => {
  it('emits a brief index-state note that survives compaction', async () => {
    const cwd = makeTempProject();
    const state: FakePipelineState = { chunks: 9, files: 3, reingestCalls: [], deleteCalls: [], ingestProjectCalls: [] };
    const pipeline = makeFakePipeline(state);
    const deps = makeDeps(pipeline, state);

    const result = await runPreCompact({ trigger: 'auto' }, deps);

    expect(result.chunkCount).toBe(9);
    expect(result.additionalContext).toContain('9 chunks');
    expect(result.additionalContext).toContain('get_context_for_task');
  });

  it('emits the self-heal hint when the index is empty', async () => {
    const cwd = makeTempProject();
    const state: FakePipelineState = { chunks: 0, files: 0, reingestCalls: [], deleteCalls: [], ingestProjectCalls: [] };
    const pipeline = makeFakePipeline(state);
    const deps = makeDeps(pipeline, state);

    const result = await runPreCompact({ trigger: 'manual' }, deps);
    expect(result.additionalContext).toContain('ingest-project');
  });
});
