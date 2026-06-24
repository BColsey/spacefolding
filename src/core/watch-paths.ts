import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { normalizeContextPath } from './ingester.js';

/**
 * Shared watch/re-index path helpers.
 *
 * These are the single source of truth for how a filesystem path becomes a
 * storage path key, and which paths are ignored. Two callers must agree on
 * both conversions or chunk keys diverge and become orphans:
 *
 *   - {@link FileWatcher} (long-running `watch` command)
 *   - the PostToolUse re-index hook (`spacefolding hook reindex`)
 *
 * Keeping the logic here (rather than duplicating it in the hook) guarantees
 * a file edited in a session re-indexes to the SAME storage path key the
 * watcher would have produced, so {@link PipelineOrchestrator.reingestFile}
 * finds and updates the right chunks.
 */

export const DEFAULT_IGNORES = ['node_modules', '.git', 'dist'];

export const BINARY_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
];

/** Load .gitignore patterns from `<root>/.gitignore` (empty if absent/unreadable). */
export function loadGitignorePatterns(root: string): string[] {
  const gitignorePath = join(root, '.gitignore');
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

/** True if `filePath` is itself a symlink (lstat, so it does NOT follow). */
export function isSymlinkPath(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Decide whether a filesystem path should be ignored for ingest/re-index.
 *
 * Reproduces the FileWatcher filters exactly:
 *   1. symlinks (never followed — security + churn),
 *   2. DEFAULT_IGNORES directory segments (node_modules/.git/dist),
 *   3. BINARY_EXTENSIONS,
 *   4. .gitignore patterns from `root`.
 */
export function shouldIgnorePath(
  filePath: string,
  gitignorePatterns: readonly string[] = [],
): boolean {
  if (isSymlinkPath(filePath)) return true;

  if (
    DEFAULT_IGNORES.some(
      (pattern) => filePath.includes(`/${pattern}/`) || filePath.endsWith(`/${pattern}`),
    )
  ) {
    return true;
  }

  if (BINARY_EXTENSIONS.some((extension) => filePath.endsWith(extension))) {
    return true;
  }

  return gitignorePatterns.some((pattern) => matchesGitignorePattern(filePath, pattern));
}

function matchesGitignorePattern(filePath: string, pattern: string): boolean {
  const normalized = pattern.replace(/^\//, '').replace(/\/$/, '');
  if (!normalized) return false;
  if (normalized.includes('*')) {
    const regex = new RegExp(
      normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'),
    );
    return regex.test(filePath);
  }
  return filePath.includes(normalized);
}

/**
 * Convert an absolute (or root-relative) filesystem path into the storage
 * path key used for chunks.
 *
 * If `filePath` is inside `root`, the result is the POSIX-normalized relative
 * path (e.g. `src/service.ts`). If it is outside `root` (out-of-tree fallback),
 * the absolute path is normalized instead. This MUST match
 * {@link FileWatcher.storagePathFor} byte-for-byte.
 */
export function storagePathFor(filePath: string, root: string): string {
  const relativePath = relative(resolve(root), resolve(filePath));
  if (relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)) {
    return normalizeContextPath(relativePath);
  }
  return normalizeContextPath(filePath);
}
