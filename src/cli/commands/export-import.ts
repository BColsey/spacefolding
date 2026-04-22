import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ContextChunk, DependencyLink, ExportData } from '../../types/index.js';
import { MIGRATIONS, CURRENT_VERSION } from '../../storage/schema.js';

interface CompressionCacheRow {
  id: string;
  taskText: string;
  summary: string;
  retainedFacts: string;
  retainedConstraints: string;
  sourceChunkIds: string;
  timestamp: number;
}

interface ExportFile extends ExportData {
  compressionCache: CompressionCacheRow[];
}

interface ChunkRow {
  id: string;
  source: string;
  type: string;
  text: string;
  timestamp: number;
  path: string | null;
  language: string | null;
  tokensEstimate: number;
  parentId: string | null;
  metadata: string;
}

export async function exportState(dbPath: string, outputPath: string): Promise<void> {
  const db = new Database(dbPath, { readonly: true });

  try {
    const rows = db.prepare('SELECT * FROM chunks').all() as ChunkRow[];
    const dependencies = db.prepare('SELECT * FROM dependencies').all() as DependencyLink[];
    const compressionCache = db
      .prepare('SELECT * FROM compression_cache')
      .all() as CompressionCacheRow[];

    const data: ExportFile = {
      version: CURRENT_VERSION,
      exportedAt: Date.now(),
      chunks: rows.map(rowToChunk),
      dependencies,
      compressionCache,
    };

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(data, null, 2));
  } finally {
    db.close();
  }
}

export async function importState(dbPath: string, inputPath: string): Promise<void> {
  const data = JSON.parse(readFileSync(inputPath, 'utf-8')) as Partial<ExportFile>;
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  try {
    initDatabase(db);

    const insertChunk = db.prepare(
      `INSERT OR REPLACE INTO chunks (id, source, type, text, timestamp, path, language, tokensEstimate, parentId, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertDependency = db.prepare(
      `INSERT OR REPLACE INTO dependencies (fromId, toId, type, weight)
       VALUES (?, ?, ?, ?)`
    );
    const insertCompression = db.prepare(
      `INSERT OR REPLACE INTO compression_cache (id, taskText, summary, retainedFacts, retainedConstraints, sourceChunkIds, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    for (const chunk of data.chunks ?? []) {
      insertChunk.run(
        chunk.id,
        chunk.source,
        chunk.type,
        chunk.text,
        chunk.timestamp,
        chunk.path ?? null,
        chunk.language ?? null,
        chunk.tokensEstimate,
        chunk.parentId ?? null,
        JSON.stringify(chunk.metadata ?? {})
      );
    }

    for (const dependency of data.dependencies ?? []) {
      insertDependency.run(
        dependency.fromId,
        dependency.toId,
        dependency.type,
        dependency.weight
      );
    }

    for (const entry of data.compressionCache ?? []) {
      insertCompression.run(
        entry.id,
        entry.taskText,
        entry.summary,
        entry.retainedFacts,
        entry.retainedConstraints,
        entry.sourceChunkIds,
        entry.timestamp
      );
    }
  } finally {
    db.close();
  }
}

function initDatabase(db: Database.Database): void {
  const userVersion = db.pragma('user_version', { simple: true }) as number;
  for (const migration of MIGRATIONS) {
    if (migration.version <= userVersion) continue;
    for (const statement of migration.up) {
      db.exec(statement);
    }
  }
  db.pragma(`user_version = ${CURRENT_VERSION}`);
}

function rowToChunk(row: ChunkRow): ContextChunk {
  return {
    id: row.id,
    source: row.source,
    type: row.type as ContextChunk['type'],
    text: row.text,
    timestamp: row.timestamp,
    path: row.path ?? undefined,
    language: row.language ?? undefined,
    tokensEstimate: row.tokensEstimate,
    parentId: row.parentId ?? undefined,
    childrenIds: [],
    metadata: JSON.parse(row.metadata),
  };
}
