import { CURRENT_VERSION } from './current-version.js';

export const CREATE_TABLE_CHUNKS = `
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  path TEXT,
  language TEXT,
  tokensEstimate INTEGER NOT NULL DEFAULT 0,
  parentId TEXT,
  metadata TEXT NOT NULL DEFAULT '{}'
)`;

export const CREATE_TABLE_DEPENDENCIES = `
CREATE TABLE IF NOT EXISTS dependencies (
  fromId TEXT NOT NULL,
  toId TEXT NOT NULL,
  type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.5,
  PRIMARY KEY (fromId, toId, type)
)`;

export const CREATE_TABLE_ROUTING_HISTORY = `
CREATE TABLE IF NOT EXISTS routing_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunkId TEXT NOT NULL,
  tier TEXT NOT NULL,
  score REAL NOT NULL,
  reasons TEXT NOT NULL DEFAULT '[]',
  taskText TEXT NOT NULL,
  timestamp INTEGER NOT NULL
)`;

export const CREATE_TABLE_COMPRESSION_CACHE = `
CREATE TABLE IF NOT EXISTS compression_cache (
  id TEXT PRIMARY KEY,
  taskText TEXT NOT NULL,
  summary TEXT NOT NULL,
  retainedFacts TEXT NOT NULL DEFAULT '[]',
  retainedConstraints TEXT NOT NULL DEFAULT '[]',
  sourceChunkIds TEXT NOT NULL DEFAULT '[]',
  timestamp INTEGER NOT NULL
)`;

export const CREATE_INDEX_CHUNKS_SOURCE = `
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source)`;

export const CREATE_INDEX_CHUNKS_TYPE = `
CREATE INDEX IF NOT EXISTS idx_chunks_type ON chunks(type)`;

export const CREATE_INDEX_CHUNKS_PATH = `
CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path)`;

export const CREATE_INDEX_DEPS_FROM = `
CREATE INDEX IF NOT EXISTS idx_deps_from ON dependencies(fromId)`;

export const CREATE_INDEX_DEPS_TO = `
CREATE INDEX IF NOT EXISTS idx_deps_to ON dependencies(toId)`;

// Phase 1: Vector persistence
export const CREATE_TABLE_EMBEDDINGS = `
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunkId TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (chunkId) REFERENCES chunks(id) ON DELETE CASCADE
)`;

export const CREATE_INDEX_EMBEDDINGS_MODEL = `
CREATE INDEX IF NOT EXISTS idx_embeddings_model ON chunk_embeddings(model)`;

// Phase 2: Full-text search
export const CREATE_FTS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  path UNINDEXED,
  source UNINDEXED,
  type UNINDEXED,
  content='chunks',
  content_rowid='rowid'
)`;

export const CREATE_FTS_INSERT_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, path, source, type)
  VALUES (new.rowid, new.text, new.path, new.source, new.type);
END`;

export const CREATE_FTS_DELETE_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, path, source, type)
  VALUES ('delete', old.rowid, old.text, old.path, old.source, old.type);
END`;

export const CREATE_FTS_UPDATE_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, path, source, type)
  VALUES ('delete', old.rowid, old.text, old.path, old.source, old.type);
  INSERT INTO chunks_fts(rowid, text, path, source, type)
  VALUES (new.rowid, new.text, new.path, new.source, new.type);
END`;

export const CREATE_INDEX_ROUTING_CHUNK = `
CREATE INDEX IF NOT EXISTS idx_routing_chunk ON routing_history(chunkId)`;

export const CREATE_INDEX_ROUTING_TIMESTAMP = `
CREATE INDEX IF NOT EXISTS idx_routing_timestamp ON routing_history(timestamp)`;

export interface Migration {
  version: number;
  up: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: [
      CREATE_TABLE_CHUNKS,
      CREATE_TABLE_DEPENDENCIES,
      CREATE_TABLE_ROUTING_HISTORY,
      CREATE_TABLE_COMPRESSION_CACHE,
      CREATE_INDEX_CHUNKS_SOURCE,
      CREATE_INDEX_CHUNKS_TYPE,
      CREATE_INDEX_CHUNKS_PATH,
      CREATE_INDEX_DEPS_FROM,
      CREATE_INDEX_DEPS_TO,
    ],
  },
  {
    version: 2,
    up: [
      CREATE_TABLE_EMBEDDINGS,
      CREATE_INDEX_EMBEDDINGS_MODEL,
    ],
  },
  {
    version: 3,
    up: [
      CREATE_FTS_TABLE,
      CREATE_FTS_INSERT_TRIGGER,
      CREATE_FTS_DELETE_TRIGGER,
      CREATE_FTS_UPDATE_TRIGGER,
      CREATE_INDEX_ROUTING_CHUNK,
      CREATE_INDEX_ROUTING_TIMESTAMP,
    ],
  },
];

export { CURRENT_VERSION };
