import type {
  ContextChunk,
  ContextFilter,
  ContextTier,
  DependencyLink,
  CompressionResult,
} from '../types/index.js';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS, CURRENT_VERSION } from './schema.js';

export class SQLiteRepository {
  private db: Database.Database;

  constructor(dbPath: string = './data/spacefolding.db') {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  init(): void {
    const userVersion = this.db.pragma('user_version', { simple: true }) as number;
    for (const migration of MIGRATIONS) {
      if (migration.version > userVersion) {
        for (const stmt of migration.up) {
          this.db.exec(stmt);
        }
      }
    }
    this.db.pragma(`user_version = ${CURRENT_VERSION}`);
  }

  storeChunk(chunk: ContextChunk): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO chunks (id, source, type, text, timestamp, path, language, tokensEstimate, parentId, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        chunk.id,
        chunk.source,
        chunk.type,
        chunk.text,
        chunk.timestamp,
        chunk.path ?? null,
        chunk.language ?? null,
        chunk.tokensEstimate,
        chunk.parentId ?? null,
        JSON.stringify(chunk.metadata)
      );
  }

  getChunk(id: string): ContextChunk | null {
    const row = this.db
      .prepare('SELECT * FROM chunks WHERE id = ?')
      .get(id) as Row | undefined;
    return row ? rowToChunk(row) : null;
  }

  queryChunks(filter: ContextFilter): ContextChunk[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.source !== undefined) {
      clauses.push('c.source = ?');
      params.push(filter.source);
    }
    if (filter.type !== undefined) {
      clauses.push('c.type = ?');
      params.push(filter.type);
    }
    if (filter.path !== undefined) {
      clauses.push('c.path = ?');
      params.push(filter.path);
    }
    if (filter.textContains !== undefined) {
      clauses.push('c.text LIKE ?');
      params.push(`%${filter.textContains}%`);
    }
    if (filter.tier !== undefined) {
      clauses.push(`EXISTS (
        SELECT 1
        FROM routing_history rh
        WHERE rh.chunkId = c.id
          AND rh.id = (
            SELECT rh2.id
            FROM routing_history rh2
            WHERE rh2.chunkId = c.id
            ORDER BY rh2.timestamp DESC, rh2.id DESC
            LIMIT 1
          )
          AND rh.tier = ?
      )`);
      params.push(filter.tier);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT c.* FROM chunks c ${where}`)
      .all(...params) as Row[];
    return rows.map(rowToChunk);
  }

  getAllChunks(): ContextChunk[] {
    const rows = this.db.prepare('SELECT * FROM chunks').all() as Row[];
    return rows.map(rowToChunk);
  }

  updateChunk(chunk: ContextChunk): void {
    this.storeChunk(chunk); // INSERT OR REPLACE
  }

  deleteChunk(id: string): void {
    this.db.prepare('DELETE FROM chunks WHERE id = ?').run(id);
    this.removeAllDependenciesForChunk(id);
  }

  storeDependency(link: DependencyLink): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO dependencies (fromId, toId, type, weight)
         VALUES (?, ?, ?, ?)`
      )
      .run(link.fromId, link.toId, link.type, link.weight);
  }

  removeDependency(fromId: string, toId: string, type: DependencyLink['type']): void {
    this.db
      .prepare('DELETE FROM dependencies WHERE fromId = ? AND toId = ? AND type = ?')
      .run(fromId, toId, type);
  }

  removeAllDependenciesForChunk(chunkId: string): void {
    this.db
      .prepare('DELETE FROM dependencies WHERE fromId = ? OR toId = ?')
      .run(chunkId, chunkId);
  }

  getDependencies(chunkId: string): DependencyLink[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM dependencies WHERE fromId = ? OR toId = ?'
      )
      .all(chunkId, chunkId) as DepRow[];
    return rows.map((r) => ({
      fromId: r.fromId,
      toId: r.toId,
      type: r.type as DependencyLink['type'],
      weight: r.weight,
    }));
  }

  storeRoutingDecision(
    chunkId: string,
    tier: ContextTier,
    score: number,
    reasons: string[],
    taskText: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO routing_history (chunkId, tier, score, reasons, taskText, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(chunkId, tier, score, JSON.stringify(reasons), taskText, Date.now());
  }

  storeCompression(result: CompressionResult & { id: string; taskText: string }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO compression_cache (id, taskText, summary, retainedFacts, retainedConstraints, sourceChunkIds, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        result.id,
        result.taskText,
        result.summary,
        JSON.stringify(result.retainedFacts),
        JSON.stringify(result.retainedConstraints),
        JSON.stringify(result.sourceChunkIds),
        Date.now()
      );
  }

  getCompression(id: string): CompressionResult | null {
    const row = this.db
      .prepare('SELECT * FROM compression_cache WHERE id = ?')
      .get(id) as CompRow | undefined;
    if (!row) return null;
    return {
      summary: row.summary,
      retainedFacts: JSON.parse(row.retainedFacts),
      retainedConstraints: JSON.parse(row.retainedConstraints),
      sourceChunkIds: JSON.parse(row.sourceChunkIds),
    };
  }

  getChunkCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM chunks').get() as {
      count: number;
    };
    return row.count;
  }

  close(): void {
    this.db.close();
  }
}

// Internal row types
interface Row {
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

interface DepRow {
  fromId: string;
  toId: string;
  type: string;
  weight: number;
}

interface CompRow {
  id: string;
  taskText: string;
  summary: string;
  retainedFacts: string;
  retainedConstraints: string;
  sourceChunkIds: string;
  timestamp: number;
}

function rowToChunk(row: Row): ContextChunk {
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

export function createRepository(dbPath?: string): SQLiteRepository {
  const repo = new SQLiteRepository(dbPath);
  repo.init();
  return repo;
}
