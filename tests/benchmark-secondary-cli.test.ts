import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs as parseAblationArgs } from '../benchmarks/ablation.ts';
import { parseArgs as parseCompressionArgs } from '../benchmarks/compression-comparison.ts';
import {
  benchmarkSqlitePath,
  createBenchmarkSqliteArtifact,
  removeSqliteArtifacts,
} from '../benchmarks/temp-artifacts.ts';

describe('secondary benchmark CLI parsing', () => {
  it('parses ablation benchmark options without executing on import', () => {
    const benchDir = '/tmp/spacefolding-benchmarks';

    expect(parseAblationArgs([], benchDir)).toEqual({
      dataset: join(benchDir, 'dataset.json'),
      localEmbeddings: false,
      gpu: false,
    });

    expect(parseAblationArgs([
      '--dataset',
      'fixtures/dataset.json',
      '--local-embeddings',
      '--gpu',
    ], benchDir)).toEqual({
      dataset: join(benchDir, 'fixtures', 'dataset.json'),
      localEmbeddings: true,
      gpu: true,
    });

    expect(parseAblationArgs(['--dataset', '/tmp/tasks.json'], benchDir).dataset).toBe(
      '/tmp/tasks.json'
    );
  });

  it('rejects malformed ablation benchmark options directly', () => {
    expect(() => parseAblationArgs(['dataset.json'], '/tmp/bench')).toThrow(
      'Unknown argument: dataset.json'
    );
    expect(() => parseAblationArgs(['--dataset'], '/tmp/bench')).toThrow(
      '--dataset requires a value'
    );
    expect(() => parseAblationArgs(['--dataset', '--gpu'], '/tmp/bench')).toThrow(
      '--dataset requires a value'
    );
    expect(() => parseAblationArgs(['--unknown'], '/tmp/bench')).toThrow(
      'Unknown argument: --unknown'
    );
  });

  it('parses compression benchmark options without executing on import', () => {
    expect(parseCompressionArgs([])).toEqual({ withLlmLingua: false });
    expect(parseCompressionArgs(['--with-llmlingua'])).toEqual({ withLlmLingua: true });
  });

  it('rejects unsupported compression benchmark options directly', () => {
    expect(() => parseCompressionArgs(['--dataset', '/tmp/tasks.json'])).toThrow(
      'Unknown argument: --dataset'
    );
    expect(() => parseCompressionArgs(['tasks.json'])).toThrow(
      'Unknown argument: tasks.json'
    );
  });

  it('keeps benchmark SQLite scratch files under /tmp and removes sidecars', () => {
    const dbPath = benchmarkSqlitePath('secondary-cli-test');
    expect(dbPath.startsWith(tmpdir())).toBe(true);

    try {
      writeFileSync(dbPath, '');
      writeFileSync(`${dbPath}-wal`, '');
      writeFileSync(`${dbPath}-shm`, '');

      removeSqliteArtifacts(dbPath);

      expect(existsSync(dbPath)).toBe(false);
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(existsSync(`${dbPath}-shm`)).toBe(false);
    } finally {
      removeSqliteArtifacts(dbPath);
    }
  });

  it('registers cleanup for benchmark SQLite artifacts', () => {
    const exitListeners = process.listenerCount('exit');
    const artifact = createBenchmarkSqliteArtifact('secondary-cli-cleanup-test');

    try {
      expect(process.listenerCount('exit')).toBe(exitListeners + 1);

      writeFileSync(artifact.path, '');
      writeFileSync(`${artifact.path}-wal`, '');
      writeFileSync(`${artifact.path}-shm`, '');

      artifact.cleanup();

      expect(process.listenerCount('exit')).toBe(exitListeners);
      expect(existsSync(artifact.path)).toBe(false);
      expect(existsSync(`${artifact.path}-wal`)).toBe(false);
      expect(existsSync(`${artifact.path}-shm`)).toBe(false);
    } finally {
      artifact.cleanup();
      removeSqliteArtifacts(artifact.path);
    }
  });
});
