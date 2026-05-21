export { SQLiteRepository, createRepository } from './repository.js';
export { MIGRATIONS, CURRENT_VERSION } from './schema.js';
export { BruteForceVectorIndex, tryCreateSqliteVecIndex } from './vector-index.js';
export type { VectorIndex, VectorSearchResult } from './vector-index.js';
