import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileWatcher } from '../src/core/watcher.js';
import type { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';

type WatcherInternals = {
  ingestFile(filePath: string, event: 'add' | 'change'): Promise<void>;
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

    expect(reingestFile).toHaveBeenCalledWith(filePath, content);
    expect(ingest).not.toHaveBeenCalled();
  });
});
