import chokidar, { type FSWatcher } from 'chokidar';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';

const DEFAULT_IGNORES = ['node_modules', '.git', 'dist'];
const BINARY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot'];

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private pending = new Map<string, NodeJS.Timeout>();
  private gitignorePatterns: string[];

  constructor(
    private watchPath: string,
    private pipeline: PipelineOrchestrator
  ) {
    this.gitignorePatterns = this.loadGitignorePatterns();
  }

  start(): void {
    if (this.watcher) return;

    this.watcher = chokidar.watch(this.watchPath, {
      ignored: (path) => this.shouldIgnore(path),
      ignoreInitial: false,
      persistent: true,
    });

    this.watcher.on('add', (filePath) => this.scheduleIngest(filePath, 'add'));
    this.watcher.on('change', (filePath) => this.scheduleIngest(filePath, 'change'));
    this.watcher.on('unlink', (filePath) => {
      process.stderr.write(`Unlinked ${filePath}; stored chunks were not deleted.\n`);
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
        this.ingestFile(filePath, event);
      }, 300)
    );
  }

  private ingestFile(filePath: string, event: 'add' | 'change'): void {
    try {
      if (!existsSync(filePath)) return;
      const content = readFileSync(filePath, 'utf-8');
      this.pipeline.ingest('file', content, undefined, filePath);
      process.stderr.write(`Watched ${event}: ${filePath}\n`);
    } catch (error) {
      process.stderr.write(`Failed to ingest ${filePath}: ${String(error)}\n`);
    }
  }

  private loadGitignorePatterns(): string[] {
    const gitignorePath = join(this.watchPath, '.gitignore');
    if (!existsSync(gitignorePath)) return [];

    try {
      return readFileSync(gitignorePath, 'utf-8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));
    } catch {
      return [];
    }
  }

  private shouldIgnore(filePath: string): boolean {
    if (DEFAULT_IGNORES.some((pattern) => filePath.includes(`/${pattern}/`) || filePath.endsWith(`/${pattern}`))) {
      return true;
    }

    if (BINARY_EXTENSIONS.some((extension) => filePath.endsWith(extension))) {
      return true;
    }

    return this.gitignorePatterns.some((pattern) => this.matchesPattern(filePath, pattern));
  }

  private matchesPattern(filePath: string, pattern: string): boolean {
    const normalized = pattern.replace(/^\//, '').replace(/\/$/, '');
    if (!normalized) return false;
    if (normalized.includes('*')) {
      const regex = new RegExp(
        normalized
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
      );
      return regex.test(filePath);
    }
    return filePath.includes(normalized);
  }
}
