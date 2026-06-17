import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildAcceptanceReport,
  buildAcceptanceReportFromFiles,
  formatTextReport,
  parseArgs,
} from '../benchmarks/check-acceptance.ts';

function passingGate() {
  return {
    requiredStrategySummaries: ['keyword', 'bm25', 'fts', 'structural'],
    missingStrategySummaries: [],
    recallNonInferiorityMargin: 0.05,
    bestLexicalStrategy: 'bm25',
    recallAt10VsBestLexical: { comparator: 'bm25', metric: 'recallAt10', mean: -0.02, low: -0.03, high: 0.01 },
    hitsAt1VsFts: { comparator: 'fts', metric: 'hitsAt1', mean: 0.3, low: 0.15, high: 0.45 },
    recallAt10NonInferior: true,
    hitsAt1BeatsFts: true,
    structuralMeetsGate: true,
  };
}

function retrievalReport() {
  return { successGate: passingGate() };
}

function e2eReport() {
  return {
    summary: {
      averageRecallVsCurrent: 0.1,
      averagePrecisionVsCurrent: 0.05,
      averageTokensVsCurrent: 1_500,
      tasksReturningMoreThanCodebase: [],
      averageRecall: 0.96,
      averagePrecision: 0.36,
      averageTokens: 12_000,
      totalCodebaseTokens: 20_000,
    },
    successGate: {
      focusedRetrievalPasses: true,
    },
  };
}

describe('acceptance checker report', () => {
  it('lists every check with pass/fail, actual, and expected values', () => {
    const report = buildAcceptanceReport({
      retrieval: retrievalReport(),
      e2e: e2eReport(),
    });

    expect(report).toMatchObject({
      passed: true,
      checks: expect.any(Array),
    });
    expect(report.checks.length).toBeGreaterThan(0);
    for (const check of report.checks) {
      expect(check).toEqual(expect.objectContaining({
        passed: expect.any(Boolean),
        actual: expect.anything(),
        expected: expect.any(String),
      }));
    }

    const text = formatTextReport(report);
    expect(text).toContain('Acceptance gate: PASS');
    expect(text).toContain(
      'PASS retrieval.composite_gate: actual=true'
    );
    expect(text.split('\n').slice(1).every((line) => (
      /^(PASS|FAIL) [^:]+: actual=.+ expected=.+$/.test(line)
    ))).toBe(true);
  });

  it('fails missing JSON sections with direct actual and expected messages', () => {
    const report = buildAcceptanceReport({
      retrieval: {
        strategies: [{
          strategy: 'keyword',
          averages: { recallAt10: 0.5, ndcgAt10: 0.4, mrr: 0.25 },
        }],
      },
      e2e: {
        summary: {
          averageRecall: 0.96,
        },
      },
    });

    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'retrieval.success_gate_present',
      passed: false,
      actual: 'missing',
      expected: 'top-level successGate object',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'e2e.recall_vs_current',
      passed: false,
      actual: 'missing/invalid: summary.averageRecallVsCurrent',
      expected: 'summary.averageRecallVsCurrent > 0',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'e2e.success_gate_present',
      passed: false,
      actual: 'missing',
      expected: 'top-level successGate object',
    }));
  });

  it('fails non-object benchmark roots and missing top-level sections directly', () => {
    const report = buildAcceptanceReport({
      retrieval: 'not an object',
      e2e: {
        successGate: {
          focusedRetrievalPasses: true,
        },
      },
    });

    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'retrieval.root_object_present',
      passed: false,
      actual: 'not an object',
      expected: 'retrieval JSON is an object',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'e2e.summary_present',
      passed: false,
      actual: 'missing',
      expected: 'top-level summary object',
    }));
  });

  it('fails when the gate cannot be computed because a strong baseline is missing', () => {
    const report = buildAcceptanceReport({
      retrieval: {
        successGate: {
          missingStrategySummaries: ['bm25', 'fts'],
        },
      },
    });

    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'retrieval.strategy_summaries_present',
      passed: false,
      actual: 'missing: bm25, fts',
      expected: 'keyword, bm25, fts, and structural strategy summaries present',
    }));
  });

  it('fails the composite gate when the structural hybrid does not meet both halves', () => {
    const report = buildAcceptanceReport({
      retrieval: {
        successGate: {
          missingStrategySummaries: [],
          recallNonInferiorityMargin: 0.05,
          bestLexicalStrategy: 'fts',
          recallAt10VsBestLexical: { comparator: 'fts', metric: 'recallAt10', mean: -0.12, low: -0.2, high: -0.04 },
          hitsAt1VsFts: { comparator: 'fts', metric: 'hitsAt1', mean: 0.0, low: -0.1, high: 0.1 },
          recallAt10NonInferior: false,
          hitsAt1BeatsFts: false,
          structuralMeetsGate: false,
        },
      },
    });

    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'retrieval.recall_non_inferior_to_best_lexical',
      passed: false,
      actual: 'structural−fts -0.120 [-0.200, -0.040]',
      expected: 'structural recall@10 ≥ fts − 0.05 (paired-CI lower bound)',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'retrieval.hits_at1_beats_fts',
      passed: false,
      actual: 'structural−fts +0.000 [-0.100, 0.100]',
      expected: 'structural hits@1 > fts (paired-CI lower bound > 0)',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'retrieval.composite_gate',
      passed: false,
      actual: false,
      expected: 'successGate.structuralMeetsGate is true (non-inferior recall AND top-1 win over fts)',
    }));
  });

  it('reports E2E tasks that return more tokens than the full codebase', () => {
    const report = buildAcceptanceReport({
      e2e: {
        summary: {
          averageRecallVsCurrent: 0.1,
          averagePrecisionVsCurrent: 0.05,
          averageTokensVsCurrent: 1_500,
          tasksReturningMoreThanCodebase: ['E01', 'E03'],
          averageRecall: 0.96,
          averagePrecision: 0.36,
          averageTokens: 22_000,
          totalCodebaseTokens: 20_000,
        },
        successGate: {
          focusedRetrievalPasses: false,
        },
      },
    });

    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'e2e.no_task_exceeds_codebase_tokens',
      passed: false,
      actual: 'E01, E03',
      expected: 'summary.tasksReturningMoreThanCodebase is an empty array',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'e2e.average_tokens_below_codebase',
      passed: false,
      actual: 22_000,
      expected: 'summary.averageTokens < summary.totalCodebaseTokens (20000)',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'e2e.success_gate',
      passed: false,
      actual: false,
      expected: 'successGate.focusedRetrievalPasses is true',
    }));
  });

  it('fails field-level E2E diagnostics when success-gate values are incomplete', () => {
    const report = buildAcceptanceReport({
      e2e: {
        summary: {
          averageRecallVsCurrent: 0.1,
          averagePrecisionVsCurrent: 0.05,
          averageTokensVsCurrent: 1_500,
          tasksReturningMoreThanCodebase: [],
          averageRecall: 0.96,
          averagePrecision: 0.36,
          averageTokens: 12_000,
          totalCodebaseTokens: 20_000,
        },
        successGate: {},
      },
    });

    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'e2e.success_gate',
      passed: false,
      actual: 'missing/invalid: successGate.focusedRetrievalPasses',
      expected: 'successGate.focusedRetrievalPasses is true',
    }));
  });

  it('represents malformed temporary JSON as a failed checker report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spacefolding-acceptance-'));
    try {
      const malformed = join(dir, 'malformed.json');
      writeFileSync(malformed, '{ malformed');

      const report = buildAcceptanceReportFromFiles({
        retrievalJson: malformed,
        json: true,
      });

      expect(report).toMatchObject({
        passed: false,
        checks: [expect.objectContaining({
          name: 'retrieval.json_readable',
          passed: false,
          actual: expect.any(String),
          expected: `valid JSON file at ${malformed}`,
        })],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('represents missing JSON files as failed checker reports', () => {
    const missingPath = join(tmpdir(), `spacefolding-missing-${Date.now()}.json`);

    const report = buildAcceptanceReportFromFiles({
      e2eJson: missingPath,
      json: true,
    });

    expect(report).toMatchObject({
      passed: false,
      checks: [expect.objectContaining({
        name: 'e2e.json_readable',
        passed: false,
        actual: expect.stringContaining('ENOENT'),
        expected: `valid JSON file at ${missingPath}`,
      })],
    });
  });

  it('reports missing checker inputs at the report-builder boundary', () => {
    const report = buildAcceptanceReport({});

    expect(report).toEqual({
      passed: false,
      checks: [{
        name: 'cli.inputs_present',
        passed: false,
        actual: 'none',
        expected: 'at least one of --retrieval-json or --e2e-json',
      }],
    });
  });

  it('fails CLI argument parsing when no input JSON path is provided', () => {
    expect(() => parseArgs(['--json'])).toThrow(
      'Provide --retrieval-json, --e2e-json, or both'
    );
    expect(() => parseArgs(['--unknown'])).toThrow(
      'Unknown argument: --unknown'
    );
  });

  it('rejects missing checker JSON path values before consuming the next flag', () => {
    expect(() => parseArgs(['--retrieval-json', '--json'])).toThrow(
      '--retrieval-json requires a JSON path'
    );
    expect(() => parseArgs(['--e2e-json'])).toThrow(
      '--e2e-json requires a JSON path'
    );
  });
});
