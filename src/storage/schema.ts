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
];

export { CURRENT_VERSION };
