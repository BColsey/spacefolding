import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildAcceptanceReport,
  buildAcceptanceReportFromFiles,
  formatTextReport,
} from '../benchmarks/check-acceptance.ts';

function retrievalReport() {
  return {
    strategies: [
      {
        strategy: 'keyword',
        averages: {
          recallAt10: 0.5,
          ndcgAt10: 0.4,
          mrr: 0.25,
        },
      },
      {
        strategy: 'structural',
        averages: {
          recallAt10: 0.7,
          ndcgAt10: 0.6,
          mrr: 0.5,
        },
      },
    ],
    successGate: {
      structuralBeatsKeyword: true,
    },
  };
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
      'PASS retrieval.recallAt10: actual=0.2 expected=structural R@10 > keyword R@10'
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
      name: 'retrieval.strategy_summaries_present',
      passed: false,
      actual: 'missing: structural',
      expected: 'keyword and structural strategy summaries present',
    }));
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
});
