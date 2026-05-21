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
    const index = new SqliteVecIndex(db, dimensions);
    index.loadFromDb();
    return index;
  } catch {
    return null;
  }
}

const VEC_TABLE = 'vec_chunk_embeddings';

class SqliteVecIndex implements VectorIndex {
  private db: Database.Database;
  private dimensionCount: number;
  private count: number;
  private initialized = false;

  constructor(db: Database.Database, dimensions: number) {
    this.db = db;
    this.dimensionCount = dimensions;
    this.ensureTable();
    this.count = this.loadCount();
  }

  private ensureTable(): void {
    if (this.initialized) return;
    // This table is a derived cache. Rebuilding it on initialization avoids
    // stale rows and handles embedding-dimension changes across model switches.
    this.db.exec(`DROP TABLE IF EXISTS ${VEC_TABLE}`);
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(
        chunkId TEXT PRIMARY KEY,
        embedding float[${this.dimensionCount}] distance_metric=cosine
      )
    `);
    this.initialized = true;
  }

  private loadCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM ${VEC_TABLE}`)
      .get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
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
    this.count = this.loadCount();
  }

  add(chunkId: string, embedding: number[]): void {
    if (embedding.length !== this.dimensionCount) {
      throw new Error(
        `Embedding dimensions ${embedding.length} do not match vector index dimensions ${this.dimensionCount}`
      );
    }
    const buf = new Float32Array(embedding);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ${VEC_TABLE}(chunkId, embedding) VALUES (?, ?)`
      )
      .run(chunkId, Buffer.from(buf.buffer));
    this.count = this.loadCount();
  }

  remove(chunkId: string): void {
    this.db
      .prepare(`DELETE FROM ${VEC_TABLE} WHERE chunkId = ?`)
      .run(chunkId);
    this.count = this.loadCount();
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
