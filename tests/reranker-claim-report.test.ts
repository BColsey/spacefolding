import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aggregateRegimeVerdicts,
  buildRerankerClaimReport,
  DEFAULT_RERANKER_CLAIM_CRITERIA,
  reportExitCode,
  type RegimeVerdict,
} from '../benchmarks/reranker-claim-report.ts';
import type { ClaimCriteria } from '../benchmarks/claim-protocol.ts';

const metrics = (hitsAt1: number, recallAt10: number, ndcgAt10: number, mrr: number) => ({
  hitsAt1,
  recallAt10,
  ndcgAt10,
  mrr,
});

const result = (
  taskId: string,
  values: ReturnType<typeof metrics>,
  tokensToFirstHit: number | null
) => ({
  taskId,
  metrics: values,
  details: {
    tokenCost: { tokensToFirstHit },
  },
});

const crossEncoderMetadata = { rerankerMode: 'cross-encoder', fallbackDetected: false };

describe('reranker claim report', () => {
  it('computes paired metric diffs and token summaries', () => {
    const baseline = {
      strategies: [{
        strategy: 'structural-plain',
        results: [
          result('a', metrics(0, 0.5, 0.4, 0.25), 100),
          result('b', metrics(1, 1, 0.8, 1), 80),
          result('c', metrics(0, 0, 0, 0), null),
        ],
      }],
    };
    const candidate = {
      strategies: [{
        strategy: 'structural-rerank-oracle',
        results: [
          result('a', metrics(1, 1, 1, 1), 40),
          result('b', metrics(1, 1, 0.9, 1), 80),
          result('c', metrics(1, 1, 1, 1), 120),
        ],
      }],
    };

    const report = buildRerankerClaimReport({
      baseline,
      candidate,
      nBoot: 100,
    });

    expect(report.baselineStrategy).toBe('structural-plain');
    expect(report.candidateStrategy).toBe('structural-rerank-oracle');
    expect(report.valid).toBe(true);
    expect(report.warnings).toEqual([]);
    expect(report.pairedTasks).toBe(3);
    expect(report.metricCIs.find((ci) => ci.metric === 'hitsAt1')?.mean).toBeCloseTo(2 / 3);
    expect(report.tokenSummary.baselineFirstHitRate).toBeCloseTo(2 / 3);
    expect(report.tokenSummary.candidateFirstHitRate).toBe(1);
    expect(report.tokenSummary.pairedHitTasks).toBe(2);
    expect(report.tokenSummary.meanTokenDiffOnPairedHits).toBe(-30);
    expect(report.tokenSummary.candidateReducedTokens).toBe(1);
    expect(report.tokenSummary.candidateTiedTokens).toBe(1);
  });

  it('marks cross-encoder fallback reports invalid evidence', () => {
    const baseline = {
      strategies: [{
        strategy: 'structural-plain',
        results: [result('a', metrics(0, 0.5, 0.4, 0.25), 100)],
      }],
    };
    const candidate = {
      strategies: [{
        strategy: 'structural-rerank-cross-encoder',
        metadata: { rerankerMode: 'cross-encoder', fallbackDetected: true },
        results: [result('a', metrics(1, 1, 1, 1), 40)],
      }],
    };

    const report = buildRerankerClaimReport({ baseline, candidate, nBoot: 50 });

    expect(report.valid).toBe(false);
    expect(report.warnings[0]).toContain('deterministic fallback');
  });

  it('fails closed when a cross-encoder report is missing fallback metadata', () => {
    const baseline = {
      strategies: [{
        strategy: 'structural-plain',
        results: [result('a', metrics(0, 0.5, 0.4, 0.25), 100)],
      }],
    };
    const candidate = {
      strategies: [{
        strategy: 'structural-rerank-cross-encoder',
        results: [result('a', metrics(1, 1, 1, 1), 40)],
      }],
    };

    const report = buildRerankerClaimReport({ baseline, candidate, nBoot: 50 });

    expect(report.valid).toBe(false);
    expect(report.verdict).toBe('inconclusive');
    expect(report.warnings[0]).toContain('missing cross-encoder metadata');
  });

  it('rejects mismatched task sets instead of silently intersecting', () => {
    const baseline = {
      dataset: 'same.json',
      corpus: 'repo',
      strategies: [{
        strategy: 'structural-plain',
        results: [
          result('a', metrics(0, 0.5, 0.4, 0.25), 100),
          result('b', metrics(1, 1, 0.8, 1), 80),
        ],
      }],
    };
    const candidate = {
      dataset: 'same.json',
      corpus: 'repo',
      strategies: [{
        strategy: 'structural-rerank-oracle',
        results: [
          result('a', metrics(1, 1, 1, 1), 40),
          result('c', metrics(1, 1, 1, 1), 120),
        ],
      }],
    };

    expect(() => buildRerankerClaimReport({ baseline, candidate, nBoot: 50 })).toThrow(
      'baseline and candidate task sets differ'
    );
  });
});

type ArmRow = { h: number; r: number; n_d: number; m: number; t: number | null };

const uniformPair = (n: number, base: ArmRow, cand: ArmRow) => ({
  baseline: {
    strategies: [{
      strategy: 'structural-plain',
      results: Array.from({ length: n }, (_, i) => result(`t${i}`, metrics(base.h, base.r, base.n_d, base.m), base.t)),
    }],
  },
  candidate: {
    strategies: [{
      strategy: 'structural-rerank-cross-encoder',
      metadata: { ...crossEncoderMetadata },
      results: Array.from({ length: n }, (_, i) => result(`t${i}`, metrics(cand.h, cand.r, cand.n_d, cand.m), cand.t)),
    }],
  },
});

describe('reranker claim verdict', () => {
  const criteria: ClaimCriteria = DEFAULT_RERANKER_CLAIM_CRITERIA;

  it('confirms when improvement metrics gain with CI excluding zero and no recall regression', () => {
    const report = buildRerankerClaimReport({
      ...uniformPair(4, { h: 0, r: 0.5, n_d: 0.4, m: 0.25, t: 100 }, { h: 1, r: 0.5, n_d: 0.9, m: 1, t: 40 }),
      criteria,
      nBoot: 200,
    });

    expect(report.verdict).toBe('confirm');
    const hits = report.criteriaEvaluation.find((e) => e.metric === 'hitsAt1');
    expect(hits?.role).toBe('improvement');
    expect(hits?.pass).toBe(true);
    expect(hits?.direction).toBe('positive');
  });

  it('is inconclusive when cross-encoder evidence fell back to deterministic', () => {
    const pair = uniformPair(2, { h: 0, r: 0.5, n_d: 0.4, m: 0.25, t: 100 }, { h: 1, r: 0.5, n_d: 0.9, m: 1, t: 40 });
    pair.candidate.strategies[0].metadata = { rerankerMode: 'cross-encoder', fallbackDetected: true };

    const report = buildRerankerClaimReport({ ...pair, criteria, nBoot: 100 });

    expect(report.valid).toBe(false);
    expect(report.verdict).toBe('inconclusive');
  });

  it('debunks when a required improvement metric lacks a paired CI confirmation', () => {
    const baseline = {
      strategies: [{
        strategy: 'structural-plain',
        results: [
          result('a', metrics(0, 0.5, 0.4, 0.25), 100),
          result('b', metrics(1, 0.5, 0.4, 0.25), 100),
          result('c', metrics(0, 0.5, 0.4, 0.25), 100),
          result('d', metrics(1, 0.5, 0.4, 0.25), 100),
        ],
      }],
    };
    const candidate = {
      strategies: [{
        strategy: 'structural-rerank-cross-encoder',
        metadata: { ...crossEncoderMetadata },
        results: [
          result('a', metrics(1, 0.5, 0.9, 1), 40),
          result('b', metrics(0, 0.5, 0.4, 0.25), 100),
          result('c', metrics(1, 0.5, 0.9, 1), 40),
          result('d', metrics(1, 0.5, 0.9, 1), 40),
        ],
      }],
    };

    const report = buildRerankerClaimReport({ baseline, candidate, criteria, nBoot: 200 });

    expect(report.verdict).toBe('debunk');
    expect(report.criteriaEvaluation.find((e) => e.metric === 'hitsAt1')?.pass).toBe(false);
  });

  it('debunks when a non-regression metric regresses with CI excluding zero', () => {
    const report = buildRerankerClaimReport({
      ...uniformPair(4, { h: 0, r: 0.8, n_d: 0.4, m: 0.25, t: 100 }, { h: 1, r: 0.2, n_d: 0.9, m: 1, t: 40 }),
      criteria,
      nBoot: 200,
    });

    expect(report.verdict).toBe('debunk');
    const recall = report.criteriaEvaluation.find((e) => e.metric === 'recallAt10');
    expect(recall?.role).toBe('nonRegression');
    expect(recall?.pass).toBe(false);
    expect(recall?.direction).toBe('negative');
  });

  it('treats tokensToFirstHit as lower-better (a reduction is the beneficial direction)', () => {
    const report = buildRerankerClaimReport({
      ...uniformPair(4, { h: 1, r: 0.5, n_d: 0.9, m: 1, t: 100 }, { h: 1, r: 0.5, n_d: 0.9, m: 1, t: 40 }),
      criteria,
      nBoot: 200,
    });

    expect(report.tokenSummary.tokenDiffCI?.direction).toBe('negative');
    expect(report.criteriaEvaluation.find((e) => e.metric === 'tokensToFirstHit')?.pass).toBe(true);
  });

  it('does not emit a token CI when all token observations are one-sided misses', () => {
    const baseline = {
      strategies: [{
        strategy: 'structural-plain',
        results: [
          result('a', metrics(0, 0.5, 0.4, 0.25), null),
          result('b', metrics(0, 0.5, 0.4, 0.25), 100),
        ],
      }],
    };
    const candidate = {
      strategies: [{
        strategy: 'structural-rerank-cross-encoder',
        metadata: { ...crossEncoderMetadata },
        results: [
          result('a', metrics(1, 1, 1, 1), 40),
          result('b', metrics(0, 0.5, 0.4, 0.25), null),
        ],
      }],
    };

    const report = buildRerankerClaimReport({ baseline, candidate, criteria, nBoot: 100 });

    expect(report.tokenSummary.tasksExcludedOneSidedMiss).toBe(2);
    expect(report.tokenSummary.tokenDiffCI).toBeNull();
    expect(report.criteriaEvaluation.find((e) => e.metric === 'tokensToFirstHit')?.pass).toBe(false);
    expect(report.verdict).toBe('debunk');
  });

  it('does not let paired-token survivors hide an adverse first-hit-rate regression', () => {
    const tokenOnlyCriteria: ClaimCriteria = {
      improvementMetrics: ['tokensToFirstHit'],
      nonRegressionMetrics: ['recallAt10'],
      requireCiExcludesZero: true,
      perRegimeAggregation: 'all',
    };
    const baseline = {
      strategies: [{
        strategy: 'structural-plain',
        results: [
          result('a', metrics(1, 0.5, 0.4, 0.25), 100),
          result('b', metrics(1, 0.5, 0.4, 0.25), 120),
        ],
      }],
    };
    const candidate = {
      strategies: [{
        strategy: 'structural-rerank-cross-encoder',
        metadata: { ...crossEncoderMetadata },
        results: [
          result('a', metrics(1, 0.5, 0.9, 1), 40),
          result('b', metrics(1, 0.5, 0.9, 1), null),
        ],
      }],
    };

    const report = buildRerankerClaimReport({ baseline, candidate, criteria: tokenOnlyCriteria, nBoot: 100 });
    const tokenEval = report.criteriaEvaluation.find((e) => e.metric === 'tokensToFirstHit');

    expect(report.tokenSummary.pairedHitTasks).toBe(1);
    expect(report.tokenSummary.candidateFirstHitTasks).toBeLessThan(report.tokenSummary.baselineFirstHitTasks);
    expect(tokenEval?.pass).toBe(false);
    expect(tokenEval?.reason).toContain('first-hit rate regressed');
    expect(report.verdict).toBe('debunk');
  });
});

describe('aggregateRegimeVerdicts', () => {
  it('confirms only when every regime confirms under "all" aggregation', () => {
    expect(aggregateRegimeVerdicts(['confirm', 'confirm', 'confirm'], 'all')).toBe('confirm');
    expect(aggregateRegimeVerdicts(['confirm', 'nuance', 'confirm'], 'all')).toBe('nuance');
    expect(aggregateRegimeVerdicts(['confirm', 'debunk'], 'all')).toBe('debunk');
    expect(aggregateRegimeVerdicts(['confirm', 'inconclusive'], 'all')).toBe('inconclusive');
  });

  it('confirms on majority under "majority" aggregation', () => {
    expect(aggregateRegimeVerdicts(['confirm', 'confirm', 'debunk'], 'majority')).toBe('confirm');
    expect(aggregateRegimeVerdicts(['debunk', 'debunk', 'confirm'], 'majority')).toBe('debunk');
    expect(aggregateRegimeVerdicts(['confirm', 'confirm', 'inconclusive'], 'majority')).toBe('confirm');
    expect(aggregateRegimeVerdicts(['debunk', 'nuance', 'nuance'], 'majority')).toBe('nuance');
    expect(aggregateRegimeVerdicts(['confirm', 'debunk', 'inconclusive'], 'majority')).toBe('inconclusive');
  });
});

describe('reportExitCode', () => {
  const plain = { h: 0, r: 0.5, n_d: 0.4, m: 0.25, t: 100 };
  const reranked = { h: 1, r: 0.5, n_d: 0.9, m: 1, t: 40 };

  it('exits 0 for valid evidence and 1 (abort) when the report is not valid evidence', () => {
    const validReport = buildRerankerClaimReport({ ...uniformPair(2, plain, reranked), nBoot: 50 });
    expect(reportExitCode(validReport)).toBe(0);

    const invalidInput = uniformPair(2, plain, reranked);
    invalidInput.candidate.strategies[0].metadata = { rerankerMode: 'cross-encoder', fallbackDetected: true };
    const invalidReport = buildRerankerClaimReport(invalidInput);

    expect(invalidReport.valid).toBe(false);
    expect(reportExitCode(invalidReport)).toBe(1);
  });

  it('can require a confirmed verdict for claim-gating commands', () => {
    const debunkedReport = buildRerankerClaimReport({
      ...uniformPair(2, { h: 1, r: 0.5, n_d: 0.9, m: 1, t: 100 }, { h: 1, r: 0.5, n_d: 0.9, m: 1, t: 40 }),
      nBoot: 50,
    });

    expect(debunkedReport.valid).toBe(true);
    expect(debunkedReport.verdict).toBe('debunk');
    expect(reportExitCode(debunkedReport)).toBe(0);
    expect(reportExitCode(debunkedReport, { requireConfirm: true })).toBe(1);
  });
});

describe('reranker claim report CLI', () => {
  it('loads manifest claimCriteria and fails --require-confirm when those criteria debunk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spacefolding-reranker-report-'));
    const baselinePath = join(dir, 'baseline.json');
    const candidatePath = join(dir, 'candidate.json');
    const manifestPath = join(dir, 'claim.json');
    const report = (strategy: string, rows: Array<{ taskId: string; h: number; t: number }>, metadata?: object) => ({
      strategies: [{
        strategy,
        ...(metadata ? { metadata } : {}),
        results: rows.map((row) => result(row.taskId, metrics(row.h, 0.5, 0.5, row.h), row.t)),
      }],
    });
    const manifest = {
      schemaVersion: 1,
      id: 'cli-criteria-test',
      title: 'CLI criteria test',
      status: 'candidate',
      claim: 'Cross-encoder rerankers improve code localization.',
      scope: 'Unit-test fixture.',
      priorArt: [{ title: 'fixture', note: 'fixture' }],
      metrics: ['hitsAt1', 'recallAt10', 'tokensToFirstHit'],
      positiveControl: { hypothesis: 'fixture', command: 'true', passCriterion: 'fixture' },
      realismGate: { regime: 'fixture', command: 'true', passCriterion: 'fixture' },
      killCriterion: 'fixture',
      claimCriteria: {
        improvementMetrics: ['hitsAt1'],
        nonRegressionMetrics: ['recallAt10'],
        requireCiExcludesZero: true,
        minEffectSize: { hitsAt1: 2 },
        perRegimeAggregation: 'all',
      },
      datasets: [
        { name: 'control', corpus: '/tmp/corpus', taskSource: '/tmp/tasks.json', realismRole: 'positive_control' },
        { name: 'real', corpus: '/tmp/corpus', taskSource: '/tmp/tasks.json', realismRole: 'real_data' },
      ],
      commands: [{ name: 'report', command: 'true', expectedOutput: 'ok' }],
      artifacts: [{ path: '/tmp/report.json', purpose: 'fixture', committed: false }],
      verdict: { outcome: 'pending', summary: 'fixture' },
    };

    try {
      writeFileSync(baselinePath, JSON.stringify(report('structural-plain', [
        { taskId: 'a', h: 0, t: 100 },
        { taskId: 'b', h: 0, t: 100 },
      ])));
      writeFileSync(candidatePath, JSON.stringify(report('structural-rerank-cross-encoder', [
        { taskId: 'a', h: 1, t: 40 },
        { taskId: 'b', h: 1, t: 40 },
      ], crossEncoderMetadata)));
      writeFileSync(manifestPath, JSON.stringify(manifest));

      const result = spawnSync('npx', [
        'tsx',
        'benchmarks/reranker-claim-report.ts',
        '--baseline',
        baselinePath,
        '--candidate',
        candidatePath,
        '--manifest',
        manifestPath,
        '--require-confirm',
        '--json',
      ], { cwd: process.cwd(), encoding: 'utf-8' });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('"verdict": "debunk"');
      expect(result.stdout).toContain('"hitsAt1"');
      expect(result.stderr).toContain('did not satisfy the requested claim gate');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
