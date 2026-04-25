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
import { cosineSimilarity } from '../providers/deterministic-embedding.js';

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

  // ── Vector Store ──────────────────────────────────────────

  storeEmbedding(chunkId: string, embedding: number[], model: string): void {
    const buffer = new Float32Array(embedding).buffer;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO chunk_embeddings (chunkId, embedding, model, dimensions, timestamp)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(chunkId, Buffer.from(buffer), model, embedding.length, Date.now());
  }

  getEmbedding(chunkId: string): { embedding: number[]; model: string } | null {
    const row = this.db
      .prepare('SELECT embedding, model, dimensions FROM chunk_embeddings WHERE chunkId = ?')
      .get(chunkId) as EmbRow | undefined;
    if (!row) return null;
    const float32 = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dimensions);
    return { embedding: Array.from(float32), model: row.model };
  }

  /** Brute-force vector search — returns topK chunk IDs ranked by cosine similarity */
  searchByVector(queryEmbedding: number[], topK: number = 50): { chunkId: string; score: number }[] {
    const rows = this.db
      .prepare('SELECT chunkId, embedding, dimensions FROM chunk_embeddings')
      .all() as Array<{ chunkId: string; embedding: Buffer; dimensions: number }>;

    const results: { chunkId: string; score: number }[] = [];
    for (const row of rows) {
      const vec = Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dimensions));
      const score = cosineSimilarity(queryEmbedding, vec);
      results.push({ chunkId: row.chunkId, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /** Check if embeddings exist for a model */
  hasEmbeddings(model?: string): boolean {
    if (model) {
      const row = this.db
        .prepare('SELECT COUNT(*) as count FROM chunk_embeddings WHERE model = ?')
        .get(model) as { count: number };
      return row.count > 0;
    }
    const row = this.db.prepare('SELECT COUNT(*) as count FROM chunk_embeddings').get() as { count: number };
    return row.count > 0;
  }

  /** Get chunk IDs that are missing embeddings for a given model */
  getChunksWithoutEmbeddings(model: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT c.id FROM chunks c
         WHERE NOT EXISTS (
           SELECT 1 FROM chunk_embeddings e WHERE e.chunkId = c.id AND e.model = ?
         )`
      )
      .all(model) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  // ── Full-Text Search ───────────────────────────────────────

  /** BM25-ranked text search using FTS5 */
  searchByText(query: string, topK: number = 50): { chunkId: string; score: number }[] {
    // Escape special FTS5 characters
    const escaped = query.replace(/"/g, '""').replace(/[{}()\[\]:;]/g, ' ').trim();
    if (!escaped) return [];

    try {
      const rows = this.db
        .prepare(
          `SELECT rowid, text, path, source, type, rank
           FROM chunks_fts
           WHERE chunks_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(escaped, topK) as Array<{ rowid: number; rank: number }>;

      // Convert FTS5 rowid back to chunk ID
      const chunkRows = this.db
        .prepare('SELECT id, rowid FROM chunks WHERE rowid IN (' + rows.map(() => '?').join(',') + ')')
        .all(...rows.map((r) => r.rowid)) as Array<{ id: string; rowid: number }>;

      const rowidToId = new Map(chunkRows.map((r) => [r.rowid, r.id]));

      return rows
        .map((r) => ({
          chunkId: rowidToId.get(r.rowid) ?? '',
          score: -r.rank, // FTS5 rank is negative BM25, negate for positive score
        }))
        .filter((r) => r.chunkId !== '');
    } catch {
      // FTS5 might not support the query syntax
      return [];
    }
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

interface EmbRow {
  chunkId: string;
  embedding: Buffer;
  model: string;
  dimensions: number;
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
