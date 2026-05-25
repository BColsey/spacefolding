import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function benchmarkSqlitePath(label: string): string {
  const safeLabel = label.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  return join(tmpdir(), `spacefolding-${safeLabel}-${process.pid}.db`);
}

export function removeSqliteArtifacts(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      unlinkSync(path);
    } catch {}
  }
}
