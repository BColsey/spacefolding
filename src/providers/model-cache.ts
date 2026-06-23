import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Resolve the shared global embedding-model cache directory.
 *
 * Uses the XDG Base Directory Specification so the ~100MB embedding model is
 * downloaded ONCE per machine and reused across every project (previously each
 * project re-downloaded into ./data/models). Resolution is deterministic — it
 * never touches Date/random.
 *
 *   ${XDG_CACHE_HOME:-$HOME/.cache}/spacefolding/models
 *
 * Honors an explicit MODEL_PATH override (kept for back-compat / pinning a
 * specific cache location), since the transformers.js env.localModelPath is the
 * actual consumer.
 */
export function getDefaultModelCacheDir(): string {
  const xdgCache = process.env.XDG_CACHE_HOME;
  const base = xdgCache && xdgCache.length > 0 ? xdgCache : join(homedir(), '.cache');
  return join(base, 'spacefolding', 'models');
}

/**
 * Resolve the effective model cache dir, honoring an explicit MODEL_PATH env
 * override, then ensure the directory exists (recursive, idempotent).
 */
export function ensureModelCacheDir(): string {
  const dir = process.env.MODEL_PATH && process.env.MODEL_PATH.length > 0
    ? process.env.MODEL_PATH
    : getDefaultModelCacheDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}
