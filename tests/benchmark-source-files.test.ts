import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  projectRelativePath,
  walkBenchmarkSourceFiles,
} from '../benchmarks/source-files.ts';

describe('benchmark source file traversal', () => {
  it('walks deterministic source inputs while skipping ignored dirs, tests, and symlinks', () => {
    const corpus = mkdtempSync(join(tmpdir(), 'spacefolding-source-walk-'));
    const external = mkdtempSync(join(tmpdir(), 'spacefolding-source-private-'));

    mkdirSync(join(corpus, 'src'), { recursive: true });
    mkdirSync(join(corpus, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(corpus, '.codex', 'work'), { recursive: true });
    writeFileSync(join(corpus, 'src', 'index.ts'), 'export const ok = true;');
    writeFileSync(join(corpus, 'src', 'index.test.ts'), 'export const test = true;');
    writeFileSync(join(corpus, '.env.example'), 'DB_PATH=/tmp/db.sqlite');
    writeFileSync(join(corpus, 'node_modules', 'pkg', 'ignored.ts'), 'export const ignored = true;');
    writeFileSync(join(corpus, '.codex', 'work', 'ignored.ts'), 'export const ignored = true;');
    writeFileSync(join(external, 'private.ts'), 'export const secret = true;');
    symlinkSync(external, join(corpus, 'src', 'linked-private'), 'dir');

    try {
      const files = walkBenchmarkSourceFiles(corpus, {
        extraFileNames: ['.env.example'],
      }).map((file) => relative(corpus, file));

      expect(files).toEqual(['.env.example', join('src', 'index.ts')]);
    } finally {
      rmSync(corpus, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it('normalizes paths relative to the project root without checkout-name assumptions', () => {
    const root = join(tmpdir(), 'not-spacefolding-checkout');
    const filePath = join(root, 'src', 'pipeline', 'orchestrator.ts');

    expect(projectRelativePath(root, filePath)).toBe('src/pipeline/orchestrator.ts');
  });
});
