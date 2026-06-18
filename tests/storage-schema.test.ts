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

describe('FTS5 external-content integrity (delete + VACUUM)', () => {
  // Regression for the rowid/content_rowid corruption class: chunks_fts is an
  // external-content table (content='chunks', content_rowid='rowid'), and the
  // chunks rowid is implicit (id is TEXT PRIMARY KEY, not an INTEGER PRIMARY KEY
  // alias). A VACUUM that renumbers implicit rowids would detach FTS rows from
  // their chunks. This asserts FTS stays correct across a delete + VACUUM cycle.
  it('keeps FTS results correct after deleting a chunk and vacuuming', () => {
    const dbPath = testDbPath();
    const repo = createRepository(dbPath);
    const store = (id: string, text: string, path: string) =>
      repo.storeChunk({
        id,
        source: 'test',
        type: 'code',
        text,
        timestamp: Date.now(),
        path,
        tokensEstimate: 4,
        childrenIds: [],
        metadata: {},
      });

    store('alpha', 'export function alphaNeedle() { return 1; }', 'src/alpha.ts');
    store('beta', 'export function betaNeedle() { return 2; }', 'src/beta.ts');
    store('gamma', 'export function gammaNeedle() { return 3; }', 'src/gamma.ts');

    expect(repo.searchByText('alphaNeedle', 5).map((r) => r.chunkId)).toContain('alpha');
    expect(repo.searchByText('betaNeedle', 5).map((r) => r.chunkId)).toContain('beta');
    expect(repo.searchByText('gammaNeedle', 5).map((r) => r.chunkId)).toContain('gamma');

    // Delete through the repo (fires the FTS delete trigger), then VACUUM on a
    // separate connection to simulate a maintenance compaction.
    repo.deleteChunk('beta');
    repo.close();

    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    db.exec('VACUUM');
    db.close();

    const reopened = createRepository(dbPath);
    expect(reopened.searchByText('betaNeedle', 5).map((r) => r.chunkId)).not.toContain('beta');
    expect(reopened.searchByText('alphaNeedle', 5).map((r) => r.chunkId)).toContain('alpha');
    expect(reopened.searchByText('gammaNeedle', 5).map((r) => r.chunkId)).toContain('gamma');
    reopened.close();
  });
});
