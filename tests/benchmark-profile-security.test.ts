import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { walkProfileCorpus } from '../benchmarks/profile-retrieval.ts';

describe('retrieval profiler corpus walking', () => {
  it('does not follow corpus symlinks outside the profiled tree', () => {
    const corpus = mkdtempSync(join(tmpdir(), 'spacefolding-profile-corpus-'));
    const external = mkdtempSync(join(tmpdir(), 'spacefolding-profile-private-'));
    mkdirSync(join(corpus, 'src'), { recursive: true });
    writeFileSync(join(corpus, 'src', 'index.ts'), 'export const ok = true;');
    writeFileSync(join(external, 'private.ts'), 'export const secret = true;');
    symlinkSync(external, join(corpus, 'src', 'linked-private'), 'dir');

    try {
      const files = walkProfileCorpus(corpus, true).map((file) => relative(corpus, file));

      expect(files).toEqual(['src/index.ts']);
    } finally {
      rmSync(corpus, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });
});
