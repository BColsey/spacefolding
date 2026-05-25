import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadAblationDataset,
  parseAblationDataset,
  parseArgs as parseAblationArgs,
} from '../benchmarks/ablation.ts';
import {
  loadCompressionDataset,
  parseArgs as parseCompressionArgs,
  parseCompressionDataset,
} from '../benchmarks/compression-comparison.ts';
import {
  benchmarkSqlitePath,
  createBenchmarkSqliteArtifact,
  removeSqliteArtifacts,
} from '../benchmarks/temp-artifacts.ts';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

  it('rejects malformed ablation datasets with direct messages', () => {
    expect(() => parseAblationDataset({ notTasks: [] }, '/tmp/ablation.json')).toThrow(
      'Ablation dataset must contain a tasks array: /tmp/ablation.json'
    );
    expect(() => parseAblationDataset({ tasks: [] }, '/tmp/ablation.json')).toThrow(
      'Ablation dataset has no tasks: /tmp/ablation.json'
    );
    expect(() => parseAblationDataset({
      tasks: [{
        id: 'T1',
        task: 'find auth controller',
        intent: 'code_search',
        relevant_files: 'src/auth.ts',
      }],
    }, '/tmp/ablation.json')).toThrow(
      'Ablation dataset task 1 field relevant_files must be an array of strings: /tmp/ablation.json'
    );
  });

  it('reports ablation dataset file failures with the dataset path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spacefolding-ablation-dataset-'));
    try {
      const malformed = join(dir, 'malformed.json');
      writeFileSync(malformed, '{ malformed');
      expect(() => loadAblationDataset(malformed)).toThrow(
        new RegExp(`Malformed ablation dataset JSON at ${escapeRegExp(malformed)}`)
      );

      const missing = join(dir, 'missing.json');
      expect(() => loadAblationDataset(missing)).toThrow(
        new RegExp(`Unable to read ablation dataset JSON at ${escapeRegExp(missing)}`)
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('rejects malformed compression datasets with direct messages', () => {
    expect(() => parseCompressionDataset(null, '/tmp/compression.json')).toThrow(
      'Compression dataset must contain a tasks array: /tmp/compression.json'
    );
    expect(() => parseCompressionDataset({ tasks: [] }, '/tmp/compression.json')).toThrow(
      'Compression dataset has no tasks: /tmp/compression.json'
    );
    expect(() => parseCompressionDataset({
      tasks: [{
        id: 'T1',
        task: 'compress retrieved context',
        intent: 'explain',
        relevant_files: [123],
      }],
    }, '/tmp/compression.json')).toThrow(
      'Compression dataset task 1 field relevant_files must be an array of strings: /tmp/compression.json'
    );
  });

  it('reports compression dataset file failures with the dataset path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spacefolding-compression-dataset-'));
    try {
      const malformed = join(dir, 'malformed.json');
      writeFileSync(malformed, '{ malformed');
      expect(() => loadCompressionDataset(malformed)).toThrow(
        new RegExp(`Malformed compression dataset JSON at ${escapeRegExp(malformed)}`)
      );

      const missing = join(dir, 'missing.json');
      expect(() => loadCompressionDataset(missing)).toThrow(
        new RegExp(`Unable to read compression dataset JSON at ${escapeRegExp(missing)}`)
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
