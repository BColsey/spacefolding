import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileWatcher } from '../src/core/watcher.js';
import type { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';

type WatcherInternals = {
  ingestFile(filePath: string, event: 'add' | 'change'): Promise<void>;
  shouldIgnore(filePath: string): boolean;
  storagePathFor(filePath: string): string;
};

const tempDirs: string[] = [];

function createTempFile(relativePath: string, content: string): { dir: string; filePath: string } {
  const dir = join(tmpdir(), `spacefolding-watcher-${Date.now()}-${tempDirs.length}`);
  tempDirs.push(dir);
  const filePath = join(dir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return { dir, filePath };
}

afterAll(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe('FileWatcher', () => {
  it('uses file re-ingestion for modified files', async () => {
    const content = 'export function run() { return true; }';
    const { dir, filePath } = createTempFile('src/service.ts', content);
    const reingestFile = vi.fn().mockResolvedValue({
      path: filePath,
      changed: true,
      chunks: [],
      reusedChunks: 0,
      createdChunks: 1,
      deletedChunks: 0,
      totalChunks: 1,
    });
    const ingest = vi.fn();
    const pipeline = {
      reingestFile,
      ingest,
      deleteChunksForPath: vi.fn(),
    } as unknown as PipelineOrchestrator;
    const watcher = new FileWatcher(dir, pipeline);

    await (watcher as unknown as WatcherInternals).ingestFile(filePath, 'change');

    expect(reingestFile).toHaveBeenCalledWith('src/service.ts', content);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('normalizes watcher file paths relative to the watched root', () => {
    const { dir, filePath } = createTempFile('src/feature/service.ts', 'export const value = true;');
    const pipeline = {
      reingestFile: vi.fn(),
      ingest: vi.fn(),
      deleteChunksForPath: vi.fn(),
    } as unknown as PipelineOrchestrator;
    const watcher = new FileWatcher(dir, pipeline);

    expect((watcher as unknown as WatcherInternals).storagePathFor(filePath))
      .toBe('src/feature/service.ts');
  });

  it('does not ingest symlinked files from watched roots', async () => {
    const watched = join(tmpdir(), `spacefolding-watcher-symlink-${Date.now()}-${tempDirs.length}`);
    const external = join(tmpdir(), `spacefolding-watcher-private-${Date.now()}-${tempDirs.length}`);
    tempDirs.push(watched, external);
    mkdirSync(join(watched, 'src'), { recursive: true });
    mkdirSync(external, { recursive: true });
    const externalFile = join(external, 'private.ts');
    const linkPath = join(watched, 'src', 'private-link.ts');
    writeFileSync(externalFile, 'export const privateValue = true;');
    symlinkSync(externalFile, linkPath, 'file');
    const pipeline = {
      reingestFile: vi.fn(),
      ingest: vi.fn(),
      deleteChunksForPath: vi.fn(),
    } as unknown as PipelineOrchestrator;
    const watcher = new FileWatcher(watched, pipeline);
    const internals = watcher as unknown as WatcherInternals;

    expect(internals.shouldIgnore(linkPath)).toBe(true);
    await internals.ingestFile(linkPath, 'add');

    expect(pipeline.ingest).not.toHaveBeenCalled();
    expect(pipeline.reingestFile).not.toHaveBeenCalled();
  });
});
