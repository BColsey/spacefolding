import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildEvaluationReport,
  loadBenchmarkDataset,
  parseBenchmarkDataset,
  parseArgs,
  resolveStrategies,
  walkDir,
  type EvalResult,
  type Metrics,
  type StrategySummary,
} from '../benchmarks/evaluate.ts';

const baseMetrics: Metrics = {
  recallAt5: 0,
  recallAt10: 0,
  recallAt20: 0,
  precisionAt5: 0,
  precisionAt10: 0,
  precisionAt20: 0,
  ndcgAt10: 0,
  ndcgAt20: 0,
  mrr: 0,
  avgResults: 0,
};

function result(metrics: Partial<Metrics> = {}): EvalResult {
  return {
    taskId: 'task-1',
    task: 'Find token verification',
    intent: 'understand',
    metrics: { ...baseMetrics, ...metrics },
    details: {
      retrievedPaths: ['src/auth.ts', 'src/cache.ts'],
      relevantPaths: ['src/auth.ts', 'src/token.ts'],
      hits: ['src/auth.ts'],
      misses: ['src/token.ts'],
      hitDetails: [{ path: 'src/auth.ts', rank: 1 }],
      retrievedPathCount: 2,
    },
  };
}

function summary(
  strategy: string,
  averages: Partial<Metrics>,
  results: EvalResult[] = [result(averages)]
): StrategySummary {
  return {
    strategy,
    averages: { ...baseMetrics, ...averages },
    results,
  };
}

describe('retrieval benchmark report', () => {
  it('defaults the benchmark corpus to project context instead of src only', () => {
    expect(parseArgs([], '/repo/benchmarks').corpus).toBe('/repo');
  });

  it('includes environment examples while skipping benchmark and local agent worktree noise', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spacefolding-evaluate-corpus-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    mkdirSync(join(tempDir, 'benchmarks'), { recursive: true });
    mkdirSync(join(tempDir, 'tests'), { recursive: true });
    mkdirSync(join(tempDir, '.claude', 'worktrees', 'agent', 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'index.ts'), 'export const ok = true;');
    writeFileSync(join(tempDir, '.env.example'), 'DB_PATH=/tmp/db.sqlite');
    writeFileSync(join(tempDir, 'benchmarks', 'ignored.ts'), 'export const ignored = true;');
    writeFileSync(join(tempDir, 'tests', 'ignored.test.ts'), 'export const ignored = true;');
    writeFileSync(join(tempDir, '.claude', 'worktrees', 'agent', 'src', 'ignored.ts'), 'export const ignored = true;');

    try {
      const files = walkDir(tempDir, false).map((file) => relative(tempDir, file));

      expect(files).toEqual(['.env.example', 'src/index.ts']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not follow corpus symlinks outside the benchmark tree', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spacefolding-evaluate-corpus-'));
    const external = mkdtempSync(join(tmpdir(), 'spacefolding-evaluate-private-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'index.ts'), 'export const ok = true;');
    writeFileSync(join(external, 'private.ts'), 'export const secret = true;');
    symlinkSync(external, join(tempDir, 'src', 'linked-private'), 'dir');

    try {
      const files = walkDir(tempDir, true).map((file) => relative(tempDir, file));

      expect(files).toEqual(['src/index.ts']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it('rejects malformed CLI arguments before running benchmark work', () => {
    expect(() => parseArgs(['--dataset', '--json'], '/benchmarks')).toThrow(
      '--dataset requires a value'
    );
    expect(() => parseArgs(['--unknown'], '/benchmarks')).toThrow(
      'Unknown argument: --unknown'
    );
    expect(() => parseArgs(['structural'], '/benchmarks')).toThrow(
      'Unknown argument: structural'
    );
  });

  it('validates requested benchmark strategies consistently', () => {
    expect(resolveStrategies('all')).toEqual([
      'keyword',
      'path-match',
      'fts',
      'vector',
      'symbol-only',
      'structural',
    ]);
    expect(resolveStrategies('structural')).toEqual(['structural']);
    expect(() => resolveStrategies('bogus')).toThrow(
      'Unknown benchmark strategy "bogus"'
    );
  });

  it('rejects malformed benchmark datasets with direct messages', () => {
    expect(() => parseBenchmarkDataset({ notTasks: [] }, '/tmp/bad-dataset.json')).toThrow(
      'Benchmark dataset must contain a tasks array: /tmp/bad-dataset.json'
    );
    expect(() => parseBenchmarkDataset({ tasks: [] }, '/tmp/bad-dataset.json')).toThrow(
      'Benchmark dataset has no tasks: /tmp/bad-dataset.json'
    );
    expect(() =>
      parseBenchmarkDataset({
        tasks: [{
          id: 'T01',
          task: 'Find token verification',
          intent: 'debug',
          relevant_files: 'src/auth.ts',
        }],
      }, '/tmp/bad-dataset.json')
    ).toThrow(
      'Benchmark dataset task 1 field relevant_files must be an array of strings: /tmp/bad-dataset.json'
    );
  });

  it('reports malformed benchmark dataset JSON with the file path', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spacefolding-evaluate-test-'));
    const datasetPath = join(tempDir, 'malformed.json');
    writeFileSync(datasetPath, '{bad json');

    try {
      expect(() => loadBenchmarkDataset(datasetPath)).toThrow(
        `Malformed benchmark dataset JSON at ${datasetPath}`
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports unreadable benchmark dataset JSON with the file path', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spacefolding-evaluate-test-'));
    const datasetPath = join(tempDir, 'missing.json');

    try {
      expect(() => loadBenchmarkDataset(datasetPath)).toThrow(
        `Unable to read benchmark dataset JSON at ${datasetPath}`
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('includes per-strategy averages and per-task hit and miss details', () => {
    const report = buildEvaluationReport({
      dataset: 'benchmarks/dataset.json',
      corpus: 'src',
      requestedStrategies: ['keyword', 'structural'],
      strategies: [
        summary('keyword', { recallAt10: 0.4, ndcgAt10: 0.3, mrr: 0.25 }),
        summary('structural', { recallAt10: 0.8, ndcgAt10: 0.7, mrr: 0.5 }),
      ],
    });

    expect(report.strategies).toHaveLength(2);
    expect(report.strategies[1].averages).toMatchObject({
      recallAt10: 0.8,
      ndcgAt10: 0.7,
      mrr: 0.5,
    });
    expect(report.strategies[1].results[0].details).toMatchObject({
      hits: ['src/auth.ts'],
      misses: ['src/token.ts'],
      hitDetails: [{ path: 'src/auth.ts', rank: 1 }],
      retrievedPathCount: 2,
    });
    expect(report.successGate.structuralBeatsKeyword).toBe(true);
    expect(report.successGate.recallAt10Delta).toBeCloseTo(0.4);
    expect(report.successGate.ndcgAt10Delta).toBeCloseTo(0.4);
    expect(report.successGate.mrrDelta).toBeCloseTo(0.25);
    expect(report.successGate.missingStrategySummaries).toEqual([]);
  });

  it('makes missing strategy summaries explicit when the strict comparison cannot run', () => {
    const report = buildEvaluationReport({
      dataset: 'benchmarks/dataset.json',
      corpus: 'src',
      requestedStrategies: ['keyword'],
      strategies: [
        summary('keyword', { recallAt10: 0.4, ndcgAt10: 0.3, mrr: 0.25 }),
      ],
    });

    expect(report.successGate.requiredStrategySummaries).toEqual(['keyword', 'structural']);
    expect(report.successGate.missingStrategySummaries).toEqual(['structural']);
    expect(report.successGate).not.toHaveProperty('structuralBeatsKeyword');
    expect(report.successGate.recallAt10Delta).toBeNull();
    expect(report.successGate.ndcgAt10Delta).toBeNull();
    expect(report.successGate.mrrDelta).toBeNull();
  });

  it('keeps structuralBeatsKeyword false with concrete deltas when structural underperforms', () => {
    const report = buildEvaluationReport({
      dataset: 'benchmarks/dataset.json',
      corpus: 'src',
      requestedStrategies: ['keyword', 'structural'],
      strategies: [
        summary('keyword', { recallAt10: 0.8, ndcgAt10: 0.7, mrr: 0.5 }),
        summary('structural', { recallAt10: 0.6, ndcgAt10: 0.75, mrr: 0.4 }),
      ],
    });

    expect(report.successGate.missingStrategySummaries).toEqual([]);
    expect(report.successGate.structuralBeatsKeyword).toBe(false);
    expect(report.successGate.recallAt10Delta).toBeCloseTo(-0.2);
    expect(report.successGate.ndcgAt10Delta).toBeCloseTo(0.05);
    expect(report.successGate.mrrDelta).toBeCloseTo(-0.1);
  });
});
