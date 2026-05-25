import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { resolveBenchmarkDbPath } from '../benchmarks/e2e-benchmark.ts';

describe('E2E benchmark database artifacts', () => {
  it('ignores DB_PATH and keeps scratch SQLite files under /tmp', () => {
    const originalDbPath = process.env.DB_PATH;
    process.env.DB_PATH = '/var/tmp/spacefolding-production.db';

    try {
      const dbPath = resolveBenchmarkDbPath();

      expect(dbPath.startsWith(tmpdir())).toBe(true);
      expect(dbPath).toContain('spacefolding-e2e-benchmark-');
      expect(dbPath.endsWith('.db')).toBe(true);
      expect(dbPath).not.toBe(process.env.DB_PATH);
    } finally {
      if (originalDbPath === undefined) {
        delete process.env.DB_PATH;
      } else {
        process.env.DB_PATH = originalDbPath;
      }
    }
  });
});
