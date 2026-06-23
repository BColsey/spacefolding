import chokidar, { type FSWatcher } from 'chokidar';
import { existsSync, readFileSync } from 'node:fs';
import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import {
  DEFAULT_IGNORES,
  loadGitignorePatterns,
  shouldIgnorePath,
  storagePathFor,
} from './watch-paths.js';

// Re-exported so existing direct imports (if any) keep resolving. The shared
// module in watch-paths.ts is now the single source of truth.
export { DEFAULT_IGNORES };

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private pending = new Map<string, NodeJS.Timeout>();
  private gitignorePatterns: string[];

  constructor(
    private watchPath: string,
    private pipeline: PipelineOrchestrator
  ) {
    this.gitignorePatterns = loadGitignorePatterns(this.watchPath);
  }

  start(): void {
    if (this.watcher) return;

    this.watcher = chokidar.watch(this.watchPath, {
      ignored: (path) => this.shouldIgnore(path),
      ignoreInitial: false,
      followSymlinks: false,
      persistent: true,
    });

    this.watcher.on('add', (filePath) => this.scheduleIngest(filePath, 'add'));
    this.watcher.on('change', (filePath) => this.scheduleIngest(filePath, 'change'));
    this.watcher.on('unlink', (filePath) => {
      const storagePath = this.storagePathFor(filePath);
      const deleted = this.pipeline.deleteChunksForPath(storagePath);
      process.stderr.write(`Unlinked ${filePath}; deleted ${deleted} stored chunks.\n`);
    });
    this.watcher.on('error', (error) => {
      process.stderr.write(`Watcher error: ${String(error)}\n`);
    });
  }

  stop(): void {
    for (const timeout of this.pending.values()) {
      clearTimeout(timeout);
    }
    this.pending.clear();

    void this.watcher?.close();
    this.watcher = null;
  }

  private scheduleIngest(filePath: string, event: 'add' | 'change'): void {
    if (this.shouldIgnore(filePath)) return;

    const pending = this.pending.get(filePath);
    if (pending) clearTimeout(pending);

    this.pending.set(
      filePath,
      setTimeout(() => {
        this.pending.delete(filePath);
        void this.ingestFile(filePath, event);
      }, 300)
    );
  }

  private async ingestFile(filePath: string, event: 'add' | 'change'): Promise<void> {
    try {
      if (!existsSync(filePath)) return;
      if (shouldIgnorePath(filePath, this.gitignorePatterns)) return;
      const content = readFileSync(filePath, 'utf-8');
      const storagePath = this.storagePathFor(filePath);
      if (event === 'change') {
        const result = await this.pipeline.reingestFile(storagePath, content);
        process.stderr.write(
          `Watched ${event}: ${filePath} (${result.reusedChunks} reused, ${result.createdChunks} created, ${result.deletedChunks} deleted)\n`
        );
      } else {
        await this.pipeline.ingest('file', content, undefined, storagePath);
        process.stderr.write(`Watched ${event}: ${filePath}\n`);
      }
    } catch (error) {
      process.stderr.write(`Failed to ingest ${filePath}: ${String(error)}\n`);
    }
  }

  private shouldIgnore(filePath: string): boolean {
    return shouldIgnorePath(filePath, this.gitignorePatterns);
  }

  private storagePathFor(filePath: string): string {
    return storagePathFor(filePath, this.watchPath);
  }
}
