import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadProfileDataset, parseArgs, parseProfileDataset } from '../benchmarks/profile-retrieval.ts';

describe('retrieval profiler CLI parsing', () => {
  it('parses profiler arguments without executing the benchmark on import', () => {
    expect(parseArgs([
      '--corpus',
      '/tmp/corpus',
      '--dataset',
      '/tmp/tasks.json',
      '--strategy',
      'hybrid',
      '--top-k',
      '25',
      '--return-limit',
      '8',
      '--max-tokens',
      '12000',
      '--json',
      '--include-tests',
    ])).toMatchObject({
      corpus: '/tmp/corpus',
      dataset: '/tmp/tasks.json',
      strategy: 'hybrid',
      topK: 25,
      returnLimit: 8,
      maxTokens: 12000,
      json: true,
      includeTests: true,
    });
  });

  it('rejects invalid profiler arguments directly', () => {
    expect(() => parseArgs(['--strategy', 'bogus'])).toThrow(
      '--strategy must be one of: structural, hybrid, vector, text, graph'
    );
    expect(() => parseArgs(['--top-k', '0'])).toThrow(
      '--top-k must be a positive integer'
    );
    expect(() => parseArgs(['--return-limit', '1.5'])).toThrow(
      '--return-limit must be a positive integer'
    );
    expect(() => parseArgs(['--max-tokens', '12000abc'])).toThrow(
      '--max-tokens must be a positive integer'
    );
    expect(() => parseArgs(['--dataset', '--json'])).toThrow(
      '--dataset requires a value'
    );
    expect(() => parseArgs(['--unknown'])).toThrow(
      'Unknown argument: --unknown'
    );
  });

  it('rejects malformed profiler datasets with direct messages', () => {
    expect(() => parseProfileDataset({ notTasks: [] }, '/tmp/profile.json')).toThrow(
      'Profiler dataset must contain a tasks array: /tmp/profile.json'
    );
    expect(() => parseProfileDataset({ tasks: [] }, '/tmp/profile.json')).toThrow(
      'Dataset has no tasks: /tmp/profile.json'
    );
    expect(() =>
      parseProfileDataset({
        tasks: [{
          id: 'P01',
          task: 42,
        }],
      }, '/tmp/profile.json')
    ).toThrow(
      'Profiler dataset task 1 field task must be a non-empty string: /tmp/profile.json'
    );
  });

  it('reports malformed profiler dataset JSON with the file path', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spacefolding-profile-test-'));
    const datasetPath = join(tempDir, 'malformed.json');
    writeFileSync(datasetPath, '{bad json');

    try {
      expect(() => loadProfileDataset(datasetPath)).toThrow(
        new RegExp(`Malformed profiler dataset JSON at ${datasetPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports unreadable profiler dataset JSON with the file path', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spacefolding-profile-test-'));
    const datasetPath = join(tempDir, 'missing.json');

    try {
      expect(() => loadProfileDataset(datasetPath)).toThrow(
        `Unable to read profiler dataset JSON at ${datasetPath}`
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
