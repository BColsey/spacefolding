import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepository } from '../src/storage/repository.js';
import { MIGRATIONS } from '../src/storage/schema.js';

let dbCounter = 0;
const dbPaths: string[] = [];

function testDbPath(): string {
  dbCounter++;
  const path = join(tmpdir(), `spacefolding-storage-schema-${Date.now()}-${dbCounter}.db`);
  dbPaths.push(path);
  return path;
}

afterAll(() => {
  for (const path of dbPaths) {
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(candidate)) unlinkSync(candidate);
    }
  }
});

describe('storage schema migrations', () => {
  it('backfills FTS rows when upgrading a database with existing chunks', () => {
    const dbPath = testDbPath();
    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');

    for (const migration of MIGRATIONS.filter((migration) => migration.version <= 2)) {
      for (const stmt of migration.up) db.exec(stmt);
    }

    db.prepare(
      `INSERT INTO chunks (id, source, type, text, timestamp, path, language, tokensEstimate, parentId, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'chunk-before-fts',
      'file',
      'code',
      'export function migrationNeedle() { return true; }',
      Date.now(),
      'src/migration.ts',
      'typescript',
      8,
      null,
      '{}'
    );

    for (const migration of MIGRATIONS.filter((migration) => migration.version > 2 && migration.version <= 4)) {
      for (const stmt of migration.up) db.exec(stmt);
    }
    db.pragma('user_version = 4');
    db.close();

    const repo = createRepository(dbPath);
    expect(repo.searchByText('migrationNeedle', 5).map((result) => result.chunkId))
      .toContain('chunk-before-fts');
    repo.close();
  });
});
