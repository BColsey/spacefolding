/**
 * Vector index abstraction for ANN / brute-force similarity search.
 *
 * Two implementations:
 * - SqliteVecIndex: uses the sqlite-vec extension for fast KNN search via
 *   a vec0 virtual table with cosine distance.
 * - BruteForceVectorIndex: in-memory cache of all embeddings that avoids
 *   re-reading from the DB on every search call. Falls back to cosine
 *   similarity computed in-process.
 */

import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import { cosineSimilarity } from '../providers/deterministic-embedding.js';

// ── Public interface ──────────────────────────────────────────

export interface VectorSearchResult {
  chunkId: string;
  score: number;
}

export interface VectorIndex {
  add(chunkId: string, embedding: number[]): void;
  addMany(items: Array<{ chunkId: string; embedding: number[] }>): void;
  remove(chunkId: string): void;
  search(queryEmbedding: number[], topK: number): VectorSearchResult[];
  size(): number;
  dimensions(): number;
}

// ── sqlite-vec backed index ───────────────────────────────────

/**
 * Attempts to create a sqlite-vec backed vector index. Returns null if
 * the extension cannot be loaded (e.g. unsupported platform).
 */
export function tryCreateSqliteVecIndex(
  db: Database.Database,
  dimensions: number,
): VectorIndex | null {
  try {
    const require = createRequire(import.meta.url);
    const sqliteVec = require('sqlite-vec') as { load: (db: Database.Database) => void };
    sqliteVec.load(db);
    const index = new SqliteVecIndex(db, dimensions); // constructor hydrates on (re)build
    return index;
  } catch {
    return null;
  }
}

const VEC_TABLE = 'vec_chunk_embeddings';
// Sidecar metadata for the derived vec0 cache. vec0 itself is created lazily here
// (not via the migration system), so its metadata is too: this records the indexed
// dimension and a rebuild counter so a reopen can detect a matching persisted index
// and skip the O(n) reload.
export const VEC_META_TABLE = 'spacefolding_vec_meta';

const COUNT_META_KEY = 'count';

class SqliteVecIndex implements VectorIndex {
  private db: Database.Database;
  private dimensionCount: number;
  private count = 0;
  private initialized = false;

  constructor(db: Database.Database, dimensions: number) {
    this.db = db;
    this.dimensionCount = dimensions;
    const rebuilt = this.ensureTable();
    if (rebuilt) {
      // Fresh table or embedding-dimension change: hydrate from chunk_embeddings.
      this.loadFromDb();
    } else {
      // A persisted vec0 at the same dimension is reused. add()/remove() keep it
      // in sync with chunk_embeddings during normal operation, so skip the O(n)
      // reload — the scale fix: reopening a 60k-vector index no longer re-inserts
      // every vector on every startup.
      const mirrored = this.readMeta(COUNT_META_KEY);
      this.count = mirrored !== null ? Number(mirrored) : this.loadCount();
      if (mirrored === null) this.setCount(this.count);
    }
  }

  /**
   * Ensure the derived vec0 cache exists at the configured dimension. Returns true
   * when the table was (re)created and must be hydrated from chunk_embeddings,
   * false when an existing persisted index at the same dimension is reused as-is.
   */
  private ensureTable(): boolean {
    if (this.initialized) return false;
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${VEC_META_TABLE}(key TEXT PRIMARY KEY, value TEXT NOT NULL)`
    );
    const storedDimRaw = this.readMeta('dimension');
    const tableExists = this.vecTableExists();
    if (
      tableExists
      && storedDimRaw !== null
      && Number(storedDimRaw) === this.dimensionCount
    ) {
      this.initialized = true;
      return false;
    }
    // First creation, dimension change, or stale metadata: rebuild the cache.
    // Dropping avoids stale rows when switching embedding models.
    this.db.exec(`DROP TABLE IF EXISTS ${VEC_TABLE}`);
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(
        chunkId TEXT PRIMARY KEY,
        embedding float[${this.dimensionCount}] distance_metric=cosine
      )
    `);
    this.writeMeta('dimension', String(this.dimensionCount));
    this.writeMeta('rebuildCount', String(this.nextRebuildCount()));
    this.initialized = true;
    return true;
  }

  private vecTableExists(): boolean {
    const row = this.db
      .prepare('SELECT 1 AS ok FROM sqlite_master WHERE name = ?')
      .get(VEC_TABLE) as { ok: number } | undefined;
    return row !== undefined;
  }

  private readMeta(key: string): string | null {
    const row = this.db
      .prepare(`SELECT value FROM ${VEC_META_TABLE} WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private writeMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO ${VEC_META_TABLE}(key, value) VALUES (?, ?)`)
      .run(key, value);
  }

  private nextRebuildCount(): number {
    const raw = this.readMeta('rebuildCount');
    const n = raw === null ? 0 : Number(raw);
    return Number.isFinite(n) ? n + 1 : 1;
  }

  private loadCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM ${VEC_TABLE}`)
      .get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  private setCount(n: number): void {
    this.count = n;
    this.writeMeta(COUNT_META_KEY, String(n));
  }

  loadFromDb(): void {
    const rows = this.db
      .prepare('SELECT chunkId, embedding, dimensions FROM chunk_embeddings WHERE dimensions = ?')
      .all(this.dimensionCount) as Array<{ chunkId: string; embedding: Buffer; dimensions: number }>;

    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO ${VEC_TABLE}(chunkId, embedding) VALUES (?, ?)`
    );
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        insert.run(row.chunkId, Buffer.from(row.embedding));
      }
    });
    tx();
    this.setCount(rows.length);
  }

  add(chunkId: string, embedding: number[]): void {
    if (embedding.length !== this.dimensionCount) {
      throw new Error(
        `Embedding dimensions ${embedding.length} do not match vector index dimensions ${this.dimensionCount}`
      );
    }
    const existed = this.db
      .prepare(`SELECT 1 AS ok FROM ${VEC_TABLE} WHERE chunkId = ?`)
      .get(chunkId) as { ok: number } | undefined;
    const buf = new Float32Array(embedding);
    this.db
      .prepare(`INSERT OR REPLACE INTO ${VEC_TABLE}(chunkId, embedding) VALUES (?, ?)`)
      .run(chunkId, Buffer.from(buf.buffer));
    this.setCount(this.count + (existed ? 0 : 1));
  }

  addMany(items: Array<{ chunkId: string; embedding: number[] }>): void {
    if (items.length === 0) return;
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO ${VEC_TABLE}(chunkId, embedding) VALUES (?, ?)`
    );
    const exists = this.db.prepare(
      `SELECT 1 AS ok FROM ${VEC_TABLE} WHERE chunkId = ?`
    );
    let added = 0;
    const tx = this.db.transaction(() => {
      for (const { chunkId, embedding } of items) {
        if (embedding.length !== this.dimensionCount) {
          throw new Error(
            `Embedding dimensions ${embedding.length} do not match vector index dimensions ${this.dimensionCount}`
          );
        }
        const existed = exists.get(chunkId) as { ok: number } | undefined;
        const buf = new Float32Array(embedding);
        insert.run(chunkId, Buffer.from(buf.buffer));
        if (!existed) added += 1;
      }
    });
    tx();
    this.setCount(this.count + added);
  }

  remove(chunkId: string): void {
    const info = this.db
      .prepare(`DELETE FROM ${VEC_TABLE} WHERE chunkId = ?`)
      .run(chunkId);
    this.setCount(Math.max(0, this.count - info.changes));
  }

  search(queryEmbedding: number[], topK: number): VectorSearchResult[] {
    if (queryEmbedding.length !== this.dimensionCount) return [];
    if (this.count === 0) return [];
    const buf = new Float32Array(queryEmbedding);
    const rows = this.db
      .prepare(
        `SELECT chunkId, distance
         FROM ${VEC_TABLE}
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`
      )
      .all(Buffer.from(buf.buffer), topK) as Array<{
      chunkId: string;
      distance: number;
    }>;

    // sqlite-vec cosine distance = 1 - cosine_similarity, so we convert back
    return rows.map((r) => ({
      chunkId: r.chunkId,
      score: 1 - r.distance,
    }));
  }

  size(): number {
    return this.count;
  }

  dimensions(): number {
    return this.dimensionCount;
  }
}

// ── In-memory brute-force index ───────────────────────────────

/**
 * Caches all embeddings in memory so each search avoids O(n) DB reads
 * and Float32Array deserialization. Uses cosine similarity.
 */
export class BruteForceVectorIndex implements VectorIndex {
  private entries = new Map<string, number[]>();

  constructor(private readonly dimensionCount: number) {}

  add(chunkId: string, embedding: number[]): void {
    if (embedding.length !== this.dimensionCount) {
      throw new Error(
        `Embedding dimensions ${embedding.length} do not match vector index dimensions ${this.dimensionCount}`
      );
    }
    this.entries.set(chunkId, embedding);
  }

  addMany(items: Array<{ chunkId: string; embedding: number[] }>): void {
    for (const { chunkId, embedding } of items) {
      this.add(chunkId, embedding);
    }
  }

  remove(chunkId: string): void {
    this.entries.delete(chunkId);
  }

  search(queryEmbedding: number[], topK: number): VectorSearchResult[] {
    if (queryEmbedding.length !== this.dimensionCount) return [];
    const results: VectorSearchResult[] = [];
    for (const [chunkId, embedding] of this.entries) {
      const score = cosineSimilarity(queryEmbedding, embedding);
      results.push({ chunkId, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  size(): number {
    return this.entries.size;
  }

  dimensions(): number {
    return this.dimensionCount;
  }

  /** Hydrate the cache from the chunk_embeddings table. */
  loadFromDb(db: Database.Database): void {
    this.entries.clear();
    const rows = db
      .prepare('SELECT chunkId, embedding, dimensions FROM chunk_embeddings WHERE dimensions = ?')
      .all(this.dimensionCount) as Array<{ chunkId: string; embedding: Buffer; dimensions: number }>;

    for (const row of rows) {
      const vec = Array.from(
        new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dimensions)
      );
      this.entries.set(row.chunkId, vec);
    }
  }
}
