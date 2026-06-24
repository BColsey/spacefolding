import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { ensureModelCacheDir } from '../../providers/model-cache.js';
import { getEmbeddingProviderName, getDefaultEmbeddingModel } from '../index.js';

export interface InitOptions {
  /** Write the local dist-path form instead of the npx form. */
  local?: boolean;
  /** Directory to write .mcp.json into (defaults to cwd). Exposed for tests. */
  cwd?: string;
  /**
   * Hook used to pre-warm the model. Defaults to the real downloadModel from
   * local-embedding; tests inject a spy to avoid the 100MB fetch.
   */
  prewarmModel?: (modelId: string) => Promise<void>;
  /** Whether to actually print to stdout (suppressed in tests). */
  silent?: boolean;
}

export interface InitResult {
  mcpJsonPath: string;
  mcpJsonForm: 'npx' | 'local';
  modelCacheDir: string;
  projectDataDir: string;
  prewarmed: boolean;
  providerName: string;
  modelId: string;
}

/** Resolve the absolute path to dist/main.js (used for the --local form). */
export function resolveLocalDistMain(cwd: string): string {
  // When running from compiled dist, this module sits at
  // <repo>/dist/cli/commands/init.js — main.js is two levels up.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, '..', '..', 'main.js');
  if (existsSync(candidate)) return candidate;
  // Fallback for source/tsx runs: <repo>/dist/main.js relative to cwd.
  return resolve(cwd, 'dist', 'main.js');
}

/** Build the .mcp.json server entry for the chosen form. */
export function buildServerEntry(form: 'npx' | 'local', localDistMain: string): Record<string, unknown> {
  if (form === 'local') {
    return {
      type: 'stdio',
      command: 'node',
      args: [localDistMain, 'serve'],
    };
  }
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'spacefolding', 'serve'],
  };
}

/**
 * Read an existing .mcp.json (or return null). Preserves any other servers /
 * top-level keys. Returns the parsed object plus whether a `spacefolding`
 * entry already existed.
 */
export function readExistingMcpJson(mcpJsonPath: string): { parsed: Record<string, unknown> | null; hasSpacefolding: boolean } {
  if (!existsSync(mcpJsonPath)) return { parsed: null, hasSpacefolding: false };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(mcpJsonPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // Unparseable: treat as absent so we don't clobber valid JSON silently,
    // but warn the user their existing .mcp.json is malformed and will be replaced.
    console.warn(
      chalk.yellow(`Warning: existing ${mcpJsonPath} is not valid JSON and will be overwritten. Back it up first if it matters.`),
    );
    return { parsed: null, hasSpacefolding: false };
  }
  const servers = (parsed.mcpServers ?? {}) as Record<string, unknown>;
  return { parsed, hasSpacefolding: Object.prototype.hasOwnProperty.call(servers, 'spacefolding') };
}

/**
 * Merge the spacefolding server entry into the parsed .mcp.json object.
 * - If no mcpServers key: create it.
 * - If spacefolding already present: overwrite only the spacefolding entry
 *   (we own this entry), leaving siblings untouched. Other top-level keys
 *   (e.g. `description`) are preserved.
 */
export function mergeServerEntry(
  parsed: Record<string, unknown> | null,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const base = parsed && typeof parsed === 'object' ? { ...parsed } : {};
  const servers = (base.mcpServers && typeof base.mcpServers === 'object')
    ? { ...(base.mcpServers as Record<string, unknown>) }
    : {};
  servers.spacefolding = entry;
  base.mcpServers = servers;
  return base;
}

export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const cwd = options.cwd ?? process.cwd();
  const providerName = getEmbeddingProviderName();
  const modelId = getDefaultEmbeddingModel(providerName);
  const log = options.silent ? () => {} : (msg: string) => console.log(msg);

  // 1. Ensure dirs: global model cache + per-project ./data (for the DB).
  const modelCacheDir = ensureModelCacheDir();
  const projectDataDir = resolve(cwd, 'data');
  mkdirSync(projectDataDir, { recursive: true });

  // 2. Pre-warm the model (skip for deterministic — no model needed).
  let prewarmed = false;
  if (providerName !== 'deterministic') {
    const prewarm = options.prewarmModel ?? defaultPrewarmModel;
    log(chalk.blue(`Pre-warming embedding model: ${modelId}`));
    log(chalk.gray(`  Cache: ${modelCacheDir}`));
    try {
      await prewarm(modelId);
      prewarmed = true;
      log(chalk.green('  ✓ Model cached'));
    } catch (err) {
      // Don't hard-fail init: embed retries lazily on first use.
      log(chalk.yellow(`  ! Pre-warm failed (${stringifyErr(err)}). Embed will retry lazily on first use.`));
    }
  } else {
    log(chalk.gray('EMBEDDING_PROVIDER=deterministic — skipping model download (no model needed).'));
  }

  // 3. Write per-project .mcp.json (machine-agnostic npx form by default).
  const form: 'npx' | 'local' = options.local ? 'local' : 'npx';
  const localDistMain = resolveLocalDistMain(cwd);
  const entry = buildServerEntry(form, localDistMain);
  const mcpJsonPath = resolve(cwd, '.mcp.json');

  const { parsed, hasSpacefolding } = readExistingMcpJson(mcpJsonPath);
  const merged = mergeServerEntry(parsed, entry);
  writeFileSync(mcpJsonPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');

  if (hasSpacefolding) {
    log(chalk.yellow(`Updated existing .mcp.json "spacefolding" entry (${form} form).`));
  } else {
    log(chalk.green(`Wrote ${mcpJsonPath}`));
  }
  if (form === 'npx') {
    log(chalk.gray('  Form: npx (resolves once the package is published). Use --local for the dist-path form.'));
  } else {
    log(chalk.gray(`  Form: local dist path → node ${localDistMain} serve`));
  }

  // 4. Next steps.
  log(chalk.blue('\nNext steps:'));
  log(chalk.gray('  • Claude Code auto-loads .mcp.json on session start (project-scoped).'));
  log(chalk.gray('    Alternatively: claude mcp add spacefolding -- node ' + localDistMain + ' serve'));
  log(chalk.gray('  • The model is cached globally — other projects reuse it (no re-download).'));
  log(chalk.gray('  • Index a repo: spacefolding ingest-project .'));

  return {
    mcpJsonPath,
    mcpJsonForm: form,
    modelCacheDir,
    projectDataDir,
    prewarmed,
    providerName,
    modelId,
  };
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function defaultPrewarmModel(modelId: string): Promise<void> {
  // Lazy import so tests that stub prewarmModel never pull transformers.js.
  const { downloadModel } = await import('../../providers/local-embedding.js');
  await downloadModel(modelId);
}
