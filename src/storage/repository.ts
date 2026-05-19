import type {
  CodeReference,
  CodeSymbol,
  ContextChunk,
  ContextFilter,
  ContextTier,
  DependencyLink,
  CompressionResult,
  StructuralQuery,
  StructuralSearchResult,
} from '../types/index.js';
import { randomUUID } from 'node:crypto';
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
    this.deleteCodeStructure(id);
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

  /** Find a chunk by a key-value pair in its JSON metadata */
  findChunkByMetadata(key: string, value: string): ContextChunk | null {
    const rows = this.db
      .prepare('SELECT * FROM chunks')
      .all() as Row[];
    for (const row of rows) {
      try {
        const meta = JSON.parse(row.metadata);
        if (meta[key] === value) return rowToChunk(row);
      } catch { continue; }
    }
    return null;
  }

  /** Find a previously ingested chunk by content hash, scoped by path for files. */
  findChunkByContentHash(contentHash: string, path?: string): ContextChunk | null {
    const rows = this.db
      .prepare(path ? 'SELECT * FROM chunks WHERE path = ?' : 'SELECT * FROM chunks WHERE path IS NULL')
      .all(...(path ? [path] : [])) as Row[];
    for (const row of rows) {
      try {
        const meta = JSON.parse(row.metadata);
        if (meta.contentHash === contentHash) return rowToChunk(row);
      } catch { continue; }
    }
    return null;
  }

  // ── Structural Code Index ─────────────────────────────────────

  storeCodeStructure(chunkId: string, symbols: CodeSymbol[], references: CodeReference[]): void {
    const insertSymbol = this.db.prepare(
      `INSERT INTO code_symbols (
        id, chunkId, path, language, name, normalizedName, kind, signature,
        startLine, endLine, isExported, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertReference = this.db.prepare(
      `INSERT INTO code_references (
        id, chunkId, path, language, target, normalizedTarget, kind,
        startLine, endLine, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const tx = this.db.transaction(() => {
      this.deleteCodeStructure(chunkId);
      for (const symbol of symbols) {
        insertSymbol.run(
          symbol.id ?? randomUUID(),
          chunkId,
          symbol.path ?? '',
          symbol.language ?? '',
          symbol.name,
          symbol.normalizedName,
          symbol.kind,
          symbol.signature ?? null,
          symbol.startLine,
          symbol.endLine,
          symbol.isExported ? 1 : 0,
          JSON.stringify(symbol.metadata ?? {})
        );
      }
      for (const reference of references) {
        insertReference.run(
          reference.id ?? randomUUID(),
          chunkId,
          reference.path ?? '',
          reference.language ?? '',
          reference.target,
          reference.normalizedTarget,
          reference.kind,
          reference.startLine,
          reference.endLine,
          JSON.stringify(reference.metadata ?? {})
        );
      }
    });
    tx();
  }

  deleteCodeStructure(chunkId: string): void {
    this.db.prepare('DELETE FROM code_symbols WHERE chunkId = ?').run(chunkId);
    this.db.prepare('DELETE FROM code_references WHERE chunkId = ?').run(chunkId);
  }

  getCodeSymbols(chunkId: string): CodeSymbol[] {
    const rows = this.db
      .prepare('SELECT * FROM code_symbols WHERE chunkId = ? ORDER BY startLine, name')
      .all(chunkId) as CodeSymbolRow[];
    return rows.map(rowToCodeSymbol);
  }

  getCodeReferences(chunkId: string): CodeReference[] {
    const rows = this.db
      .prepare('SELECT * FROM code_references WHERE chunkId = ? ORDER BY startLine, target')
      .all(chunkId) as CodeReferenceRow[];
    return rows.map(rowToCodeReference);
  }

  getAllCodeSymbols(): CodeSymbol[] {
    const rows = this.db
      .prepare('SELECT * FROM code_symbols ORDER BY path, startLine, name')
      .all() as CodeSymbolRow[];
    return rows.map(rowToCodeSymbol);
  }

  hasCodeStructure(): boolean {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM code_symbols')
      .get() as { count: number };
    return row.count > 0;
  }

  searchByStructure(query: StructuralQuery, topK: number = 50): StructuralSearchResult[] {
    const scores = new Map<string, StructuralSearchResult>();
    const normalizedIdentifiers = new Set(query.normalizedIdentifiers);
    const identifierParts = new Set(query.identifierParts);
    const pathTokens = new Set(query.pathTokens);
    const queryPathParts = new Set([
      ...query.identifierParts,
      ...query.tokens.map((token) => normalizeSearchTerm(token)).filter((token) => token.length > 2),
    ]);
    const quotedTerms = new Set(query.quotedTerms.map((term) => normalizeSearchTerm(term)));

    const addScore = (
      chunkId: string,
      structuralScore: number,
      dependencyBoost: number,
      reason: string
    ) => {
      if (structuralScore <= 0 && dependencyBoost <= 0) return;
      const existing = scores.get(chunkId) ?? {
        chunkId,
        score: 0,
        structuralScore: 0,
        dependencyBoost: 0,
        reasons: [],
      };
      existing.structuralScore += structuralScore;
      existing.dependencyBoost = Math.min(0.12, existing.dependencyBoost + dependencyBoost);
      if (!existing.reasons.includes(reason) && existing.reasons.length < 6) {
        existing.reasons.push(reason);
      }
      existing.score = existing.structuralScore + existing.dependencyBoost;
      scores.set(chunkId, existing);
    };

    const pathRows = this.db
      .prepare(`SELECT id, path, language FROM chunks WHERE path IS NOT NULL AND path != ''`)
      .all() as Array<{ id: string; path: string; language: string | null }>;
    for (const row of pathRows) {
      const lowerPath = row.path.toLowerCase();
      const basename = lowerPath.split('/').pop() ?? lowerPath;
      const basenameParts = splitSearchIdentifier(basename.replace(/\.[^.]+$/, ''));

      for (const fragment of query.pathFragments) {
        const lowerFragment = fragment.toLowerCase();
        if (lowerPath === lowerFragment || lowerPath.endsWith(`/${lowerFragment}`)) {
          addScore(row.id, 1.4, 0, `path exact match: ${fragment}`);
        } else if (lowerPath.includes(lowerFragment)) {
          addScore(row.id, 0.9, 0, `path fragment match: ${fragment}`);
        } else if (basename.includes(lowerFragment)) {
          addScore(row.id, 0.55, 0, `filename match: ${fragment}`);
        }
      }

      for (const token of pathTokens) {
        if (token.length > 1 && lowerPath.includes(token)) {
          addScore(row.id, 0.12, 0, `path token match: ${token}`);
        }
      }

      for (const part of queryPathParts) {
        if (part.length <= 2) continue;
        if (basename.includes(part)) {
          addScore(row.id, 0.5, 0, `filename token match: ${part}`);
        } else if (lowerPath.includes(part)) {
          addScore(row.id, 0.25, 0, `path token match: ${part}`);
        } else if (basenameParts.some((basenamePart) => commonPrefixLength(part, basenamePart) >= 4)) {
          addScore(row.id, 0.28, 0, `filename fuzzy match: ${part}`);
        }
      }

      for (const ext of query.extensions) {
        if (lowerPath.endsWith(`.${ext}`)) {
          addScore(row.id, 0.08, 0, `extension match: .${ext}`);
        }
      }
    }

    const symbolRows = this.db
      .prepare('SELECT * FROM code_symbols')
      .all() as CodeSymbolRow[];
    for (const row of symbolRows) {
      const normalizedName = row.normalizedName;
      if (normalizedIdentifiers.has(normalizedName) || quotedTerms.has(normalizedName)) {
        addScore(row.chunkId, row.isExported ? 1.35 : 1.25, 0, `symbol exact match: ${row.name}`);
        continue;
      }

      let overlap = 0;
      for (const part of splitSearchIdentifier(row.name)) {
        if (identifierParts.has(part)) overlap++;
      }
      if (overlap > 0) {
        addScore(
          row.chunkId,
          Math.min(0.75, overlap * 0.25) + (row.isExported ? 0.05 : 0),
          0,
          `symbol token match: ${row.name}`
        );
      }

      for (const identifier of normalizedIdentifiers) {
        if (identifier.length > 2 && normalizedName.includes(identifier)) {
          addScore(row.chunkId, 0.45, 0, `symbol partial match: ${row.name}`);
        }
      }
    }

    const referenceRows = this.db
      .prepare('SELECT * FROM code_references')
      .all() as CodeReferenceRow[];
    for (const row of referenceRows) {
      const target = row.normalizedTarget;
      for (const identifier of normalizedIdentifiers) {
        if (identifier.length > 2 && (target === identifier || target.includes(identifier))) {
          addScore(row.chunkId, 0.18, 0.05, `direct reference match: ${row.target}`);
        }
      }
      for (const part of identifierParts) {
        if (part.length > 2 && target.includes(part)) {
          addScore(row.chunkId, 0.04, 0.02, `reference token boost: ${row.target}`);
        }
      }
    }

    return [...scores.values()]
      .map((result) => ({
        ...result,
        score: result.structuralScore + result.dependencyBoost,
      }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
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
    // Tokenize: lowercase, strip punctuation, remove stop words
    const stopWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her',
      'was', 'one', 'our', 'out', 'has', 'have', 'from', 'been', 'were', 'will',
      'would', 'could', 'should', 'than', 'then', 'into', 'when', 'where', 'which',
      'their', 'that', 'this', 'with', 'does', 'how', 'what', 'why', 'who', 'its',
    ]);
    const words = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));
    if (words.length === 0) return [];

    // Build safe FTS5 OR query with quoted terms
    const ftsQuery = words.map((w) => `"${w}"`).join(' OR ');

    try {
      const rows = this.db
        .prepare(
          `SELECT rowid, text, path, source, type, rank
           FROM chunks_fts
           WHERE chunks_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(ftsQuery, topK) as Array<{ rowid: number; rank: number }>;

      if (rows.length === 0) return [];

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

  /** Deterministic lexical fallback over chunk text and paths. */
  searchByLexical(query: string, topK: number = 50): { chunkId: string; score: number }[] {
    const stopWords = new Set([
      'that', 'this', 'with', 'from', 'does', 'have', 'been', 'were', 'will',
      'would', 'could', 'should', 'than', 'then', 'into', 'when', 'where',
      'which', 'their',
    ]);
    const terms = query
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((term) => term.length > 3 && !stopWords.has(term));
    const uniqueTerms = [...new Set(terms)];
    if (uniqueTerms.length === 0) return [];

    const rows = this.db
      .prepare('SELECT id, text, path FROM chunks')
      .all() as Array<{ id: string; text: string; path: string | null }>;

    const scored = rows.map((chunk) => {
      const text = chunk.text.toLowerCase();
      const path = (chunk.path ?? '').toLowerCase();
      let score = 0;
      for (const term of uniqueTerms) {
        if (`${text} ${path}`.includes(term)) score += 2;
        if (path.includes(term)) score += 3;
      }
      return { chunkId: chunk.id, score };
    });

    return scored
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
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

interface CodeSymbolRow {
  id: string;
  chunkId: string;
  path: string;
  language: string;
  name: string;
  normalizedName: string;
  kind: string;
  signature: string | null;
  startLine: number;
  endLine: number;
  isExported: number;
  metadata: string;
}

interface CodeReferenceRow {
  id: string;
  chunkId: string;
  path: string;
  language: string;
  target: string;
  normalizedTarget: string;
  kind: string;
  startLine: number;
  endLine: number;
  metadata: string;
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

function rowToCodeSymbol(row: CodeSymbolRow): CodeSymbol {
  return {
    id: row.id,
    chunkId: row.chunkId,
    path: row.path || undefined,
    language: row.language || undefined,
    name: row.name,
    normalizedName: row.normalizedName,
    kind: row.kind as CodeSymbol['kind'],
    signature: row.signature ?? undefined,
    startLine: row.startLine,
    endLine: row.endLine,
    isExported: row.isExported === 1,
    metadata: JSON.parse(row.metadata),
  };
}

function rowToCodeReference(row: CodeReferenceRow): CodeReference {
  return {
    id: row.id,
    chunkId: row.chunkId,
    path: row.path || undefined,
    language: row.language || undefined,
    target: row.target,
    normalizedTarget: row.normalizedTarget,
    kind: row.kind as CodeReference['kind'],
    startLine: row.startLine,
    endLine: row.endLine,
    metadata: JSON.parse(row.metadata),
  };
}

function normalizeSearchTerm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_$]/g, '');
}

function splitSearchIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_$./:-]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 1);
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let count = 0;
  while (count < max && a[count] === b[count]) count++;
  return count;
}

export function createRepository(dbPath?: string): SQLiteRepository {
  const repo = new SQLiteRepository(dbPath);
  repo.init();
  return repo;
}
