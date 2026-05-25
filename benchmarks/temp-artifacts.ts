import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface BenchmarkSqliteArtifact {
  path: string;
  cleanup: () => void;
}

export function benchmarkSqlitePath(label: string): string {
  const safeLabel = label.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  return join(tmpdir(), `spacefolding-${safeLabel}-${process.pid}.db`);
}

export function createBenchmarkSqliteArtifact(label: string): BenchmarkSqliteArtifact {
  const path = benchmarkSqlitePath(label);
  removeSqliteArtifacts(path);

  let cleaned = false;
  const cleanupOnExit = () => {
    if (cleaned) return;
    cleaned = true;
    removeSqliteArtifacts(path);
  };

  process.once('exit', cleanupOnExit);

  return {
    path,
    cleanup: () => {
      process.off('exit', cleanupOnExit);
      cleanupOnExit();
    },
  };
}

export function removeSqliteArtifacts(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      unlinkSync(path);
    } catch {}
  }
}
