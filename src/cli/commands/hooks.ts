import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PipelineOrchestrator } from '../../pipeline/orchestrator.js';
import { createIngestPolicy, type IngestPolicy } from '../../security/ingest-policy.js';
import {
  shouldIgnorePath,
  storagePathFor,
  loadGitignorePatterns,
} from '../../core/watch-paths.js';

/**
 * CLI hook subcommands — the INTERFACE layer.
 *
 * The MCP server is the ENGINE (ingest/score/retrieve/reindex). These hooks
 * are how a Claude Code session drives that engine with ZERO manual tool calls:
 *
 *   - `session-start`  (SessionStart): auto-index the repo on first run +
 *     inject a small "context pack" note. Skips bulk index if the repo is huge
 *     or if cwd is outside SF_INGEST_ROOTS.
 *   - `reindex`        (PostToolUse Edit|Write): re-ingest the one edited file
 *     via {@link PipelineOrchestrator.reingestFile}, keeping chunk keys aligned
 *     with the FileWatcher (same storagePathFor conversion).
 *   - `pre-compact`    (PreCompact): re-inject a brief index-state note so
 *     awareness survives compaction.
 *
 * SECURITY (non-negotiable): every auto-index / re-index path calls
 * `createIngestPolicy({cwd}).assertAllowed(path)` FIRST. A denial logs to
 * stderr and skips — it NEVER reaches the orchestrator. GPU provider is never
 * forced: EMBEDDING_PROVIDER is whatever the environment already sets.
 */

/** Above this many project files, SessionStart skips bulk auto-index. */
export const SESSION_START_MAX_FILES = parseInt(
  process.env.SF_SESSION_START_MAX_FILES ?? '20000',
  10,
);

// --- stdin shapes (subset of the Claude Code hook contract) ---

export interface SessionStartInput {
  cwd?: string;
  source?: string;
  session_id?: string;
}

export interface PostToolUseInput {
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string };
  session_id?: string;
}

export interface PreCompactInput {
  cwd?: string;
  trigger?: string;
  custom_instructions?: string;
}

// --- structured results (returned to the thin CLI wrapper) ---

export interface HookContextOutput {
  /** additionalContext for the session (SessionStart / PreCompact). */
  additionalContext?: string;
}

export interface SessionStartResult extends HookContextOutput {
  action: 'indexed' | 'fresh' | 'skipped-too-large' | 'skipped-denied' | 'skipped-empty-cwd';
  fileCount?: number;
  chunkCount: number;
}

export interface ReindexResult {
  action: 'reindexed' | 'deleted' | 'ignored' | 'denied' | 'no-file-path' | 'missing';
  storagePath?: string;
  reusedChunks?: number;
  createdChunks?: number;
  deletedChunks?: number;
}

export interface PreCompactResult extends HookContextOutput {
  chunkCount: number;
}

// --- deps the functions need (injectable for tests) ---
//
// openPipeline is async so the real impl can use a dynamic ESM import of
// createPipeline (avoiding a module-load-time cycle: cli/index.ts imports this
// module for the command registration). Tests inject a sync fake returning a
// resolved promise.

export interface HookDeps {
  /** Open the per-cwd pipeline. Caller owns its lifecycle (must close()). */
  openPipeline(dbPath: string): Promise<PipelineOrchestrator>;
  /** Count the project files a bulk ingest would process (size guard). */
  countProjectFiles(cwd: string): number;
  /** Read the DB path for a cwd (mirrors how the CLI resolves --db). */
  resolveDbPath(cwd: string): string;
  /** Read stdin as a string (the raw hook JSON). */
  readStdin(): Promise<string>;
  /** Write a line to stderr (progress / denial logs). */
  logError(message: string): void;
  /** Read a file's utf-8 text, or null if unreadable/missing. */
  readFileText(absPath: string): string | null;
  /** Whether a path exists on disk. */
  exists(absPath: string): boolean;
}

// Cached dynamic import of createPipeline (ESM). Resolved once, reused.
let pipelineFactoryCache: ((dbPath: string) => PipelineOrchestrator) | null = null;
async function loadPipelineFactory(): Promise<(dbPath: string) => PipelineOrchestrator> {
  if (!pipelineFactoryCache) {
    const mod = await import('../index.js');
    pipelineFactoryCache = mod.createPipeline;
  }
  return pipelineFactoryCache;
}

let countProjectFilesCache: ((dir: string) => number) | null = null;
async function loadCountProjectFiles(): Promise<(dir: string) => number> {
  if (!countProjectFilesCache) {
    const mod = await import('../../pipeline/orchestrator.js');
    countProjectFilesCache = mod.countProjectFiles;
  }
  return countProjectFilesCache;
}

/** Default deps bound to the real filesystem + process. */
export function createDefaultHookDeps(): HookDeps {
  return {
    openPipeline: async (dbPath) => {
      const factory = await loadPipelineFactory();
      return factory(dbPath);
    },
    countProjectFiles: (cwd) => {
      // The cached sync fn is available after the first loadCountProjectFiles().
      // The CLI path primes both caches before invoking a hook (see cli* fns).
      if (countProjectFilesCache) return countProjectFilesCache(cwd);
      return 0;
    },
    resolveDbPath: (cwd) => process.env.DB_PATH ?? resolve(cwd, 'data', 'spacefolding.db'),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks).toString('utf-8');
    },
    logError: (message) => process.stderr.write(`${message}\n`),
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
  };
}

function safeParseJson<T>(text: string): T | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {} as T;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

/** Resolve cwd from input, falling back to CLAUDE_PROJECT_DIR / process.cwd(). */
function resolveCwd(input: { cwd?: string } | null): string {
  if (input?.cwd && input.cwd.length > 0) return input.cwd;
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

/**
 * SessionStart hook.
 *
 * - Empty index + allowed cwd + not too large → ingestProject(cwd), inject note.
 * - Empty index + cwd DENIED by SF_INGEST_ROOTS → skip, emit hint (never index).
 * - Empty index + huge project → skip bulk index, emit self-heal hint.
 * - Non-empty index → freshness note (PostToolUse keeps it current).
 */
export async function runSessionStart(
  input: SessionStartInput | null,
  deps: HookDeps,
): Promise<SessionStartResult> {
  const cwd = resolveCwd(input);
  const dbPath = deps.resolveDbPath(cwd);

  const pipeline = await deps.openPipeline(dbPath);
  try {
    const stats = pipeline.getStats();
    if (stats.totalChunks > 0) {
      return {
        action: 'fresh',
        chunkCount: stats.totalChunks,
        additionalContext: buildFreshnessContext(stats.totalChunks, stats.files.length),
      };
    }

    // Empty index. Gate cwd itself through the allowlist.
    const policy = createIngestPolicy({ cwd });
    const denied = policy.assertAllowed(cwd);
    if (denied) {
      deps.logError(`[spacefolding hook session-start] ${denied}`);
      return {
        action: 'skipped-denied',
        chunkCount: 0,
        additionalContext: buildDeniedContext(),
      };
    }

    // Size guard: do NOT block session start on a huge bulk index.
    const fileCount = deps.countProjectFiles(cwd);
    if (fileCount > SESSION_START_MAX_FILES) {
      deps.logError(
        `[spacefolding hook session-start] project has ${fileCount} files ` +
          `(> SF_SESSION_START_MAX_FILES=${SESSION_START_MAX_FILES}); skipping bulk auto-index. ` +
          `Run \`spacefolding ingest-project .\` manually to index.`,
      );
      return {
        action: 'skipped-too-large',
        fileCount,
        chunkCount: 0,
        additionalContext: buildTooLargeContext(fileCount),
      };
    }

    deps.logError(`[spacefolding hook session-start] indexing ${fileCount} project files...`);
    const result = await pipeline.ingestProject(cwd);
    const afterStats = pipeline.getStats();
    deps.logError(
      `[spacefolding hook session-start] indexed ${result.files} files ` +
        `(${afterStats.totalChunks} chunks).`,
    );
    return {
      action: 'indexed',
      fileCount: result.files,
      chunkCount: afterStats.totalChunks,
      additionalContext: buildIndexedContext(afterStats.totalChunks, result.files),
    };
  } finally {
    pipeline.close();
  }
}

/**
 * PostToolUse (Edit|Write) re-index hook.
 *
 * Single-file re-ingest via {@link PipelineOrchestrator.reingestFile}. Enforces
 * SF_INGEST_ROOTS + shouldIgnore + the SAME storagePathFor conversion the
 * FileWatcher uses, so chunk keys stay aligned.
 */
export async function runReindex(
  input: PostToolUseInput | null,
  deps: HookDeps,
): Promise<ReindexResult> {
  const cwd = resolveCwd(input);
  const filePath = input?.tool_input?.file_path;
  if (!filePath || filePath.length === 0) {
    return { action: 'no-file-path' };
  }

  const absPath = resolve(cwd, filePath);
  const policy = createIngestPolicy({ cwd });

  // SECURITY: allowlist FIRST. A denied path never reaches the orchestrator.
  const denied = policy.assertAllowed(absPath);
  if (denied) {
    deps.logError(`[spacefolding hook reindex] ${denied}`);
    return { action: 'denied', storagePath: absPath };
  }

  // shouldIgnore: node_modules/.git/dist/binary/symlink/.gitignore churn filter.
  const gitignore = loadGitignorePatterns(cwd);
  if (shouldIgnorePath(absPath, gitignore)) {
    return { action: 'ignored', storagePath: absPath };
  }

  // storagePathFor MUST match FileWatcher exactly (orphan-path-key risk).
  const storagePath = storagePathFor(absPath, cwd);

  // Unlink: the file is gone → delete its chunks.
  if (!deps.exists(absPath)) {
    const dbPath = deps.resolveDbPath(cwd);
    const pipeline = await deps.openPipeline(dbPath);
    try {
      const deleted = pipeline.deleteChunksForPath(storagePath);
      deps.logError(`[spacefolding hook reindex] deleted ${deleted} chunks for ${storagePath}`);
      return { action: 'deleted', storagePath, deletedChunks: deleted };
    } finally {
      pipeline.close();
    }
  }

  const content = deps.readFileText(absPath);
  if (content === null) {
    deps.logError(`[spacefolding hook reindex] could not read ${absPath}; skipping.`);
    return { action: 'missing', storagePath };
  }

  const dbPath = deps.resolveDbPath(cwd);
  const pipeline = await deps.openPipeline(dbPath);
  try {
    const result = await pipeline.reingestFile(storagePath, content);
    deps.logError(
      `[spacefolding hook reindex] ${storagePath} ` +
        `(${result.reusedChunks} reused, ${result.createdChunks} created, ${result.deletedChunks} deleted)`,
    );
    return {
      action: 'reindexed',
      storagePath,
      reusedChunks: result.reusedChunks,
      createdChunks: result.createdChunks,
      deletedChunks: result.deletedChunks,
    };
  } finally {
    pipeline.close();
  }
}

/** PreCompact hook: re-inject a brief index-state note post-compaction. */
export async function runPreCompact(
  input: PreCompactInput | null,
  deps: HookDeps,
): Promise<PreCompactResult> {
  const cwd = resolveCwd(input);
  const dbPath = deps.resolveDbPath(cwd);
  const pipeline = await deps.openPipeline(dbPath);
  try {
    const stats = pipeline.getStats();
    return {
      chunkCount: stats.totalChunks,
      additionalContext: buildFreshnessContext(stats.totalChunks, stats.files.length),
    };
  } finally {
    pipeline.close();
  }
}

// --- context-string builders (kept short — these go into the prompt) ---

function buildIndexedContext(chunkCount: number, fileCount: number): string {
  return (
    `Spacefolding indexed ${fileCount} project files (${chunkCount} chunks). ` +
    `For task context, call get_context_for_task(task) or retrieve_context(query).`
  );
}

function buildFreshnessContext(chunkCount: number, fileCount: number): string {
  if (chunkCount === 0) {
    return (
      'Spacefolding index is empty for this project. ' +
      'Run `spacefolding ingest-project .` to index, then call get_context_for_task(task).'
    );
  }
  return (
    `Spacefolding index is warm: ${chunkCount} chunks across ${fileCount} files. ` +
    `For task context, call get_context_for_task(task) or retrieve_context(query).`
  );
}

function buildTooLargeContext(fileCount: number): string {
  return (
    `Spacefolding skipped auto-index: project has ${fileCount} files. ` +
    `Run \`spacefolding ingest-project .\` to index manually, then call get_context_for_task(task).`
  );
}

function buildDeniedContext(): string {
  // Do NOT echo the full denial (it lists roots). Keep the hint actionable.
  return (
    'Spacefolding did not auto-index: cwd is outside SF_INGEST_ROOTS. ' +
    'Set SF_INGEST_ROOTS to allow this project, then call get_context_for_task(task).'
  );
}

// --- thin CLI wrappers: parse stdin, run, emit hook JSON ---

function emitContext(additionalContext: string | undefined): void {
  if (!additionalContext) return;
  // SessionStart/PreCompact accept the JSON hookSpecificOutput form.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext,
      },
    }) + '\n',
  );
}

/** Prime the dynamic-import caches so the sync countProjectFiles dep works. */
async function warmDeps(deps: HookDeps): Promise<void> {
  if (deps === defaultDepsSingleton) {
    await loadPipelineFactory();
    await loadCountProjectFiles();
  }
}

let defaultDepsSingleton: HookDeps | null = null;

export async function cliSessionStart(deps?: HookDeps): Promise<void> {
  const d = deps ?? createDefaultHookDeps();
  if (!deps) defaultDepsSingleton = d;
  await warmDeps(d);
  const text = await d.readStdin();
  const input = safeParseJson<SessionStartInput>(text);
  if (text.trim().length > 0 && input === null) {
    d.logError('[spacefolding hook session-start] could not parse stdin JSON; proceeding with defaults.');
  }
  const result = await runSessionStart(input ?? {}, d);
  emitContext(result.additionalContext);
}

export async function cliReindex(deps?: HookDeps): Promise<void> {
  const d = deps ?? createDefaultHookDeps();
  if (!deps) defaultDepsSingleton = d;
  await warmDeps(d);
  const text = await d.readStdin();
  const input = safeParseJson<PostToolUseInput>(text);
  if (input === null) {
    d.logError('[spacefolding hook reindex] could not parse stdin JSON; exiting.');
    return;
  }
  await runReindex(input, d);
}

export async function cliPreCompact(deps?: HookDeps): Promise<void> {
  const d = deps ?? createDefaultHookDeps();
  if (!deps) defaultDepsSingleton = d;
  await warmDeps(d);
  const text = await d.readStdin();
  const input = safeParseJson<PreCompactInput>(text);
  const result = await runPreCompact(input ?? {}, d);
  emitContext(result.additionalContext);
}

// Re-export for tests that want to assert the conversion directly.
export { storagePathFor, shouldIgnorePath, createIngestPolicy };
export type { IngestPolicy };
