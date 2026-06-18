import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../src/storage/repository.js';

let dbCounter = 0;
const dbPaths: string[] = [];

function testDbPath(): string {
  dbCounter += 1;
  const path = join(tmpdir(), `spacefolding-vector-index-${Date.now()}-${dbCounter}.db`);
  dbPaths.push(path);
  return path;
}

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${path}${suffix}`;
    if (existsSync(target)) rmSync(target);
  }
}

function storeTestChunk(repo: ReturnType<typeof createRepository>, id: string): void {
  repo.storeChunk({
    id,
    source: 'test',
    type: 'fact',
    text: `chunk ${id}`,
    timestamp: Date.now(),
    tokensEstimate: 2,
    childrenIds: [],
    metadata: {},
  });
}

afterAll(() => {
  for (const path of dbPaths) cleanupDb(path);
});

describe('SQLiteRepository vector index', () => {
  it('hydrates the vector index from embeddings that existed before initialization', () => {
    const repo = createRepository(testDbPath());
    storeTestChunk(repo, 'a');
    storeTestChunk(repo, 'b');
    repo.storeEmbedding('a', [1, 0, 0], 'test-3d');
    repo.storeEmbedding('b', [0, 1, 0], 'test-3d');

    repo.initVectorIndex(3);
    const results = repo.searchByVector([0, 1, 0], 2);

    expect(results.map((result) => result.chunkId)).toEqual(['b', 'a']);
    repo.close();
  });

  it('rebuilds the derived index when embedding dimensions change', () => {
    const repo = createRepository(testDbPath());
    storeTestChunk(repo, 'three-d');
    storeTestChunk(repo, 'two-d');
    repo.storeEmbedding('three-d', [1, 0, 0], 'test-3d');
    repo.initVectorIndex(3);

    repo.storeEmbedding('two-d', [0, 1], 'test-2d');
    const twoDimensional = repo.searchByVector([0, 1], 10);
    const threeDimensional = repo.searchByVector([1, 0, 0], 10);

    expect(twoDimensional.map((result) => result.chunkId)).toEqual(['two-d']);
    expect(threeDimensional.map((result) => result.chunkId)).toEqual(['three-d']);
    repo.close();
  });

  it('removes deleted chunks from the active vector index', () => {
    const repo = createRepository(testDbPath());
    storeTestChunk(repo, 'a');
    storeTestChunk(repo, 'b');
    repo.storeEmbedding('a', [1, 0, 0], 'test-3d');
    repo.storeEmbedding('b', [0, 1, 0], 'test-3d');
    repo.initVectorIndex(3);

    repo.deleteChunk('b');
    const results = repo.searchByVector([0, 1, 0], 10);

    expect(results.map((result) => result.chunkId)).not.toContain('b');
    expect(results.map((result) => result.chunkId)).toEqual(['a']);
    repo.close();
  });

  it('removes a chunk from the active vector index when stored text changes', () => {
    const repo = createRepository(testDbPath());
    storeTestChunk(repo, 'a');
    storeTestChunk(repo, 'b');
    repo.storeEmbedding('a', [1, 0, 0], 'test-3d');
    repo.storeEmbedding('b', [0, 1, 0], 'test-3d');
    repo.initVectorIndex(3);

    repo.storeChunk({
      id: 'b',
      source: 'test',
      type: 'fact',
      text: 'chunk b changed',
      timestamp: Date.now(),
      tokensEstimate: 3,
      childrenIds: [],
      metadata: {},
    });
    const results = repo.searchByVector([0, 1, 0], 10);

    expect(repo.getEmbedding('b')).toBeNull();
    expect(results.map((result) => result.chunkId)).not.toContain('b');
    expect(results.map((result) => result.chunkId)).toEqual(['a']);
    repo.close();
  });

  it('does not rebuild the vec0 cache when reopened at the same dimension', () => {
    // Regression for the scale pathology: vec0 was DROPped+rebuilt+reloaded from
    // chunk_embeddings on every init, so reopening a 60k-vector index re-inserted
    // every vector on every startup. It must now persist and be reused.
    const path = testDbPath();
    const repo = createRepository(path);
    storeTestChunk(repo, 'a');
    repo.storeEmbedding('a', [1, 0, 0], 'test-3d');
    repo.initVectorIndex(3);
    expect(repo.searchByVector([1, 0, 0], 1).map((r) => r.chunkId)).toEqual(['a']);
    const rebuildsAfterInit = repo.getVectorIndexRebuildCount();
    expect(rebuildsAfterInit).toBeGreaterThanOrEqual(1);
    repo.close();

    // Reopen the SAME db at the SAME dimension: the persisted vec0 must be reused,
    // not rebuilt (rebuildCount unchanged) and still searchable.
    const reopened = createRepository(path);
    reopened.initVectorIndex(3);
    expect(reopened.getVectorIndexRebuildCount()).toBe(rebuildsAfterInit);
    expect(reopened.searchByVector([1, 0, 0], 1).map((r) => r.chunkId)).toEqual(['a']);
    reopened.close();
    cleanupDb(path);
  });

  it('still rebuilds the vec0 cache when the embedding dimension changes', () => {
    const path = testDbPath();
    const repo = createRepository(path);
    storeTestChunk(repo, 'three-d');
    repo.storeEmbedding('three-d', [1, 0, 0], 'test-3d');
    repo.initVectorIndex(3);
    const rebuildsBefore = repo.getVectorIndexRebuildCount();

    storeTestChunk(repo, 'two-d');
    repo.storeEmbedding('two-d', [0, 1], 'test-2d'); // dimension mismatch triggers re-init

    expect(repo.getVectorIndexRebuildCount()).toBeGreaterThan(rebuildsBefore);
    repo.close();
    cleanupDb(path);
  });
});
