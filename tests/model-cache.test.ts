import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDefaultModelCacheDir, ensureModelCacheDir } from '../src/providers/model-cache.js';

describe('model-cache: shared global cache resolution', () => {
  const prevXdg = process.env.XDG_CACHE_HOME;
  const prevModelPath = process.env.MODEL_PATH;

  beforeEach(() => {
    delete process.env.XDG_CACHE_HOME;
    delete process.env.MODEL_PATH;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = prevXdg;
    if (prevModelPath === undefined) delete process.env.MODEL_PATH; else process.env.MODEL_PATH = prevModelPath;
  });

  it('resolves under $XDG_CACHE_HOME/spacefolding/models when XDG_CACHE_HOME is set', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sf-xdg-'));
    process.env.XDG_CACHE_HOME = tmp;
    try {
      expect(getDefaultModelCacheDir()).toBe(join(tmp, 'spacefolding', 'models'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('falls back to $HOME/.cache/spacefolding/models when XDG_CACHE_HOME is unset', () => {
    // Sanity: path shape, without hard-coding the runner's $HOME.
    const dir = getDefaultModelCacheDir();
    expect(dir.endsWith(join('.cache', 'spacefolding', 'models'))).toBe(true);
  });

  it('ensureModelCacheDir creates the dir (recursive) and returns its path', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sf-ensure-'));
    process.env.MODEL_PATH = join(tmp, 'nested', 'models'); // override honored
    try {
      const dir = ensureModelCacheDir();
      expect(dir).toBe(join(tmp, 'nested', 'models'));
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('ensureModelCacheDir uses the global default when MODEL_PATH is unset', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sf-default-'));
    process.env.XDG_CACHE_HOME = tmp;
    try {
      const dir = ensureModelCacheDir();
      expect(dir).toBe(join(tmp, 'spacefolding', 'models'));
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('ensureModelCacheDir is idempotent (no throw on re-run)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sf-idem-'));
    process.env.MODEL_PATH = join(tmp, 'models');
    try {
      expect(() => ensureModelCacheDir()).not.toThrow();
      expect(() => ensureModelCacheDir()).not.toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
