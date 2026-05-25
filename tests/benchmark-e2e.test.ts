import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildE2EReport,
  loadE2EDatasetTasks,
  parseE2EDatasetTasks,
  parseArgs,
  type TaskComparison,
} from '../benchmarks/e2e-benchmark.ts';

function comparison(
  taskId: string,
  overrides: Partial<TaskComparison['spacefold']> = {}
): TaskComparison {
  const expectedFile = `src/${taskId}.ts`;
  return {
    task: {
      id: taskId,
      name: `Task ${taskId}`,
      description: `Change ${taskId}`,
      expectedFiles: [expectedFile],
      expectedChanges: `Update ${taskId}`,
    },
    baseline: {
      filesNeeded: 1,
      totalTokensAllFiles: 1_000,
      totalTokensCodebase: 20_000,
      totalFilesCodebase: 10,
    },
    spacefold: {
      filesFound: [expectedFile],
      filesMissed: [],
      recall: 1,
      precision: 0.5,
      tokensUsed: 10_000,
      tokensBudget: 50_000,
      utilization: 0.2,
      chunksReturned: 4,
      relevantChunks: 2,
      tokensVsCurrent: 2_000,
      recallVsCurrent: 0.1,
      precisionVsCurrent: 0.05,
      tokensVsFullCodebase: -10_000,
      returnedMoreThanCodebase: false,
      ...overrides,
    },
    savingsVsRelevant: -900,
    savingsVsCodebase: 50,
  };
}

describe('E2E benchmark report', () => {
  it('parses E2E CLI arguments with explicit strategy validation', () => {
    expect(parseArgs(['--strategy', 'hybrid', '--json'])).toEqual({
      strategy: 'hybrid',
      json: true,
    });
    expect(parseArgs(['--strategy', 'graph', '--dataset', '/tmp/tasks.json'])).toEqual({
      strategy: 'graph',
      json: false,
      dataset: '/tmp/tasks.json',
    });
    expect(() => parseArgs(['--strategy', 'bogus'])).toThrow(
      '--strategy must be one of: structural, hybrid, vector, text, graph'
    );
    expect(() => parseArgs(['--dataset', '--json'])).toThrow(
      '--dataset requires a value'
    );
    expect(() => parseArgs(['--unknown'])).toThrow(
      'Unknown argument: --unknown'
    );
  });

  it('rejects malformed E2E datasets with direct messages', () => {
    expect(() => parseE2EDatasetTasks({ notTasks: [] }, '/tmp/bad-e2e.json')).toThrow(
      'E2E dataset must contain a tasks array: /tmp/bad-e2e.json'
    );
    expect(() => parseE2EDatasetTasks({ tasks: [] }, '/tmp/bad-e2e.json')).toThrow(
      'E2E dataset has no tasks: /tmp/bad-e2e.json'
    );
    expect(() =>
      parseE2EDatasetTasks({
        tasks: [{
          id: 'E01',
          task: 'Find token verification',
          intent: 'debug',
        }],
      }, '/tmp/bad-e2e.json')
    ).toThrow(
      'E2E dataset task 1 field relevant_files must be an array of strings: /tmp/bad-e2e.json'
    );
  });

  it('reports malformed E2E dataset JSON with the file path', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spacefolding-e2e-test-'));
    const datasetPath = join(tempDir, 'malformed.json');
    writeFileSync(datasetPath, '{bad json');

    try {
      expect(() => loadE2EDatasetTasks(datasetPath)).toThrow(
        `Malformed E2E dataset JSON at ${datasetPath}`
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('maps held-out benchmark dataset tasks into E2E comparisons', () => {
    expect(parseE2EDatasetTasks({
      tasks: [{
        id: 'E01',
        task: 'Find token verification',
        intent: 'debug',
        relevant_files: ['src/auth.ts'],
      }],
    }, '/tmp/e2e.json')).toEqual([{
      id: 'E01',
      name: 'debug: Find token verification',
      description: 'Find token verification',
      expectedFiles: ['src/auth.ts'],
      expectedChanges: 'Complete the debug task described above.',
    }]);
  });

  it('rejects empty comparison sets instead of emitting misleading averages', () => {
    expect(() =>
      buildE2EReport({
        strategy: 'structural',
        comparisons: [],
      })
    ).toThrow('Cannot build E2E benchmark report for an empty comparison set');
  });

  it('summarizes average recall, precision, tokens, codebase tokens, and current deltas', () => {
    const report = buildE2EReport({
      strategy: 'structural',
      comparisons: [
        comparison('E01'),
        comparison('E02', {
          precision: 0.4,
          tokensUsed: 12_000,
          tokensVsCurrent: 1_500,
          recallVsCurrent: 0.2,
          precisionVsCurrent: 0.15,
        }),
      ],
    });

    expect(report.summary).toMatchObject({
      totalFilesHit: 2,
      totalFilesNeeded: 2,
      totalTokens: 22_000,
      averageTokens: 11_000,
      totalCodebaseTokens: 20_000,
      averageTokensVsCurrent: 1_750,
      tasksReturningMoreThanCodebase: [],
    });
    expect(report.summary.averageRecall).toBeCloseTo(1);
    expect(report.summary.averagePrecision).toBeCloseTo(0.45);
    expect(report.summary.averageRecallVsCurrent).toBeCloseTo(0.15);
    expect(report.summary.averagePrecisionVsCurrent).toBeCloseTo(0.1);
    expect(report.summary.selectedVsCurrentDeltas.averageTokens).toBe(1_750);
    expect(report.summary.selectedVsCurrentDeltas.averageRecall).toBeCloseTo(0.15);
    expect(report.summary.selectedVsCurrentDeltas.averagePrecision).toBeCloseTo(0.1);
    expect(report.summary.currentVsStructuralDeltas).toEqual(
      report.summary.selectedVsCurrentDeltas
    );
    expect(report.successGate.focusedRetrievalPasses).toBe(true);
  });

  it('lists tasks returning more tokens than the full codebase and fails the success gate', () => {
    const report = buildE2EReport({
      strategy: 'structural',
      comparisons: [
        comparison('E01', {
          tokensUsed: 21_000,
          tokensVsCurrent: -1_000,
          tokensVsFullCodebase: 1_000,
          returnedMoreThanCodebase: true,
        }),
      ],
    });

    expect(report.summary.tasksReturningMoreThanCodebase).toEqual(['E01']);
    expect(report.successGate.tasksReturningMoreThanCodebase).toEqual(['E01']);
    expect(report.successGate.focusedRetrievalPasses).toBe(false);
  });

  it('does not label non-structural runs as current-vs-structural deltas', () => {
    const report = buildE2EReport({
      strategy: 'hybrid',
      comparisons: [comparison('E01')],
    });

    expect(report.summary.currentVsStructuralDeltas).toBeNull();
    expect(report.summary.selectedVsCurrentDeltas).toEqual({
      averageTokens: 2_000,
      averageRecall: 0.1,
      averagePrecision: 0.05,
    });
  });

  it('fails the success gate when focused retrieval misses thresholds or current deltas', () => {
    const report = buildE2EReport({
      strategy: 'structural',
      comparisons: [
        comparison('E01', {
          recall: 0.5,
          precision: 0.2,
          tokensUsed: 14_000,
          tokensVsCurrent: -500,
          recallVsCurrent: -0.1,
          precisionVsCurrent: 0,
        }),
      ],
    });

    expect(report.summary).toMatchObject({
      averageRecall: 0.5,
      averagePrecision: 0.2,
      averageTokens: 14_000,
      averageTokensVsCurrent: -500,
      averageRecallVsCurrent: -0.1,
      averagePrecisionVsCurrent: 0,
    });
    expect(report.successGate).toMatchObject({
      focusedRetrievalPasses: false,
      averageRecall: 0.5,
      averagePrecision: 0.2,
      averageTokens: 14_000,
      tasksReturningMoreThanCodebase: [],
    });
  });
});
