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
}

// ── sqlite-vec backed index ───────────────────────────────────

/**
 * Attempts to create a sqlite-vec backed vector index. Returns null if
 * the extension cannot be loaded (e.g. unsupported platform).
 */
export async function tryCreateSqliteVecIndex(
  db: Database.Database,
  dimensions: number,
): Promise<VectorIndex | null> {
  try {
    const sqliteVec = await import('sqlite-vec');
    sqliteVec.load(db);
    return new SqliteVecIndex(db, dimensions);
  } catch {
    return null;
  }
}

const VEC_TABLE = 'vec_chunk_embeddings';

class SqliteVecIndex implements VectorIndex {
  private db: Database.Database;
  private dimensions: number;
  private count: number;
  private initialized = false;

  constructor(db: Database.Database, dimensions: number) {
    this.db = db;
    this.dimensions = dimensions;
    this.ensureTable();
    this.count = this.loadCount();
  }

  private ensureTable(): void {
    if (this.initialized) return;
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(
        chunkId TEXT PRIMARY KEY,
        embedding float[${this.dimensions}] distance_metric=cosine
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

  add(chunkId: string, embedding: number[]): void {
    const buf = new Float32Array(embedding);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ${VEC_TABLE}(chunkId, embedding) VALUES (?, ?)`
      )
      .run(chunkId, Buffer.from(buf.buffer));
    this.count++;
  }

  remove(chunkId: string): void {
    this.db
      .prepare(`DELETE FROM ${VEC_TABLE} WHERE chunkId = ?`)
      .run(chunkId);
    this.count = Math.max(0, this.count - 1);
  }

  search(queryEmbedding: number[], topK: number): VectorSearchResult[] {
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
}

// ── In-memory brute-force index ───────────────────────────────

/**
 * Caches all embeddings in memory so each search avoids O(n) DB reads
 * and Float32Array deserialization. Uses cosine similarity.
 */
export class BruteForceVectorIndex implements VectorIndex {
  private entries = new Map<string, number[]>();

  add(chunkId: string, embedding: number[]): void {
    this.entries.set(chunkId, embedding);
  }

  remove(chunkId: string): void {
    this.entries.delete(chunkId);
  }

  search(queryEmbedding: number[], topK: number): VectorSearchResult[] {
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

  /** Hydrate the cache from the chunk_embeddings table. */
  loadFromDb(db: Database.Database): void {
    const rows = db
      .prepare('SELECT chunkId, embedding, dimensions FROM chunk_embeddings')
      .all() as Array<{ chunkId: string; embedding: Buffer; dimensions: number }>;

    for (const row of rows) {
      const vec = Array.from(
        new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dimensions)
      );
      this.entries.set(row.chunkId, vec);
    }
  }
}
