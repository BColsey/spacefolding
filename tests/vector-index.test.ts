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
});
