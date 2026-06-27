import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairedDiffCI } from './paired-bootstrap.js';
import { loadClaimManifest, type ClaimCriteria } from './claim-protocol.js';

interface Metrics {
  hitsAt1: number;
  recallAt10: number;
  ndcgAt10: number;
  mrr: number;
  [key: string]: number;
}

interface TokenCost {
  tokensToFirstHit: number | null;
}

interface EvalResult {
  taskId: string;
  metrics: Metrics;
  details: {
    tokenCost?: TokenCost;
  };
}

interface StrategyMetadata {
  rerankerMode?: string;
  fallbackDetected?: boolean;
  [key: string]: unknown;
}

interface StrategySummary {
  strategy: string;
  metadata?: StrategyMetadata;
  results: EvalResult[];
}

interface EvaluationReport {
  dataset?: string;
  corpus?: string;
  strategies: StrategySummary[];
}

export interface RerankerClaimMetricCI {
  metric: 'hitsAt1' | 'recallAt10' | 'ndcgAt10' | 'mrr';
  mean: number;
  low: number;
  high: number;
  excludesZero: boolean;
  /** Sign of the paired diff once the CI is accounted for (positive = candidate up). */
  direction: MetricDirection;
}

export type MetricDirection = 'positive' | 'negative' | 'ambiguous';

export type RegimeVerdict = 'confirm' | 'debunk' | 'nuance' | 'inconclusive';

export interface RerankerClaimTokenCI {
  mean: number;
  low: number;
  high: number;
  excludesZero: boolean;
  direction: MetricDirection;
}

export interface RerankerClaimTokenSummary {
  pairedTasks: number;
  baselineFirstHitTasks: number;
  candidateFirstHitTasks: number;
  baselineFirstHitRate: number;
  candidateFirstHitRate: number;
  pairedHitTasks: number;
  /** Tasks where exactly one arm found a first hit — these are EXCLUDED from the
   * paired-token comparison, so report this to keep the selection transparent. */
  tasksExcludedOneSidedMiss: number;
  baselineMeanTokensToFirstHit: number | null;
  candidateMeanTokensToFirstHit: number | null;
  meanTokenDiffOnPairedHits: number | null;
  /** Paired-bootstrap CI over the candidate−baseline token diffs (paired-hit tasks). */
  tokenDiffCI: RerankerClaimTokenCI | null;
  candidateReducedTokens: number;
  candidateIncreasedTokens: number;
  candidateTiedTokens: number;
}

export interface CriteriaEvaluation {
  metric: string;
  role: 'improvement' | 'nonRegression';
  direction: MetricDirection;
  mean: number;
  pass: boolean;
  reason: string;
}

export interface RerankerClaimReport {
  baselineStrategy: string;
  candidateStrategy: string;
  valid: boolean;
  warnings: string[];
  pairedTasks: number;
  /** The enforceable verdict derived from the claimCriteria, not a point-estimate eyeball. */
  verdict: RegimeVerdict;
  criteria: ClaimCriteria;
  criteriaEvaluation: CriteriaEvaluation[];
  metricCIs: RerankerClaimMetricCI[];
  tokenSummary: RerankerClaimTokenSummary;
}

const CLAIM_METRICS: RerankerClaimMetricCI['metric'][] = ['hitsAt1', 'recallAt10', 'ndcgAt10', 'mrr'];

/** Metrics where a candidate−baseline DECREASE is the beneficial direction. */
const LOWER_BETTER_METRICS = new Set<string>(['tokensToFirstHit']);

/**
 * Default operationalization of "reliably improves": every improvement metric
 * must move in the beneficial direction with its paired CI excluding zero and
 * clear a small effect-size floor, with no non-regression metric regressing,
 * in every declared regime. Used when a manifest does not override it.
 */
export const DEFAULT_RERANKER_CLAIM_CRITERIA: ClaimCriteria = {
  improvementMetrics: ['hitsAt1', 'tokensToFirstHit'],
  nonRegressionMetrics: ['recallAt10'],
  requireCiExcludesZero: true,
  minEffectSize: { hitsAt1: 0.02 },
  perRegimeAggregation: 'all',
};

function directionOf(low: number, high: number): MetricDirection {
  if (low > 0) return 'positive';
  if (high < 0) return 'negative';
  return 'ambiguous';
}

/** Combine per-regime verdicts into the overall claim verdict. */
export function aggregateRegimeVerdicts(
  verdicts: RegimeVerdict[],
  aggregation: ClaimCriteria['perRegimeAggregation']
): RegimeVerdict {
  if (verdicts.length === 0) return 'inconclusive';
  if (aggregation === 'all') {
    if (verdicts.includes('inconclusive')) return 'inconclusive';
    if (verdicts.every((v) => v === 'confirm')) return 'confirm';
    if (verdicts.includes('debunk')) return 'debunk';
    return 'nuance';
  }
  const confirms = verdicts.filter((v) => v === 'confirm').length;
  const debunks = verdicts.filter((v) => v === 'debunk').length;
  if (confirms > verdicts.length / 2) return 'confirm';
  if (debunks > verdicts.length / 2) return 'debunk';
  if (verdicts.includes('inconclusive')) return 'inconclusive';
  return 'nuance';
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function finiteToken(result: EvalResult): number | null {
  const value = result.details.tokenCost?.tokensToFirstHit;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function selectSummary(report: EvaluationReport, strategy?: string): StrategySummary {
  if (strategy) {
    const summary = report.strategies.find((s) => s.strategy === strategy);
    if (!summary) {
      throw new Error(`strategy ${strategy} not in report (have: ${report.strategies.map((s) => s.strategy).join(', ')})`);
    }
    return summary;
  }
  if (report.strategies.length !== 1) {
    throw new Error('report has multiple strategies; pass --baseline-strategy or --candidate-strategy');
  }
  return report.strategies[0];
}

function assertCompatibleReports(baseline: EvaluationReport, candidate: EvaluationReport): void {
  if (baseline.dataset && candidate.dataset && baseline.dataset !== candidate.dataset) {
    throw new Error(`baseline and candidate datasets differ: ${baseline.dataset} != ${candidate.dataset}`);
  }
  if (baseline.corpus && candidate.corpus && baseline.corpus !== candidate.corpus) {
    throw new Error(`baseline and candidate corpora differ: ${baseline.corpus} != ${candidate.corpus}`);
  }
}

function duplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort();
}

function assertSameTaskSet(baseline: StrategySummary, candidate: StrategySummary): void {
  const baselineIds = baseline.results.map((r) => r.taskId);
  const candidateIds = candidate.results.map((r) => r.taskId);
  const baselineDuplicates = duplicateIds(baselineIds);
  const candidateDuplicates = duplicateIds(candidateIds);
  if (baselineDuplicates.length || candidateDuplicates.length) {
    throw new Error(
      `duplicate task ids in paired reports: baseline=[${baselineDuplicates.join(', ')}], candidate=[${candidateDuplicates.join(', ')}]`
    );
  }
  const baselineSet = new Set(baselineIds);
  const candidateSet = new Set(candidateIds);
  const missing = baselineIds.filter((id) => !candidateSet.has(id));
  const extra = candidateIds.filter((id) => !baselineSet.has(id));
  if (missing.length || extra.length) {
    throw new Error(
      `baseline and candidate task sets differ: missingFromCandidate=[${missing.join(', ')}], extraInCandidate=[${extra.join(', ')}]`
    );
  }
}

function reportWarnings(candidate: StrategySummary): string[] {
  const warnings: string[] = [];
  const claimsCrossEncoder = candidate.strategy === 'structural-rerank-cross-encoder'
    || candidate.metadata?.rerankerMode === 'cross-encoder';
  if (!claimsCrossEncoder) return warnings;

  if (candidate.metadata?.rerankerMode !== 'cross-encoder') {
    warnings.push(
      `${candidate.strategy} is missing cross-encoder metadata; this report is not valid evidence for a cross-encoder reranker claim.`
    );
  } else if (candidate.metadata.fallbackDetected === true) {
    warnings.push(
      `${candidate.strategy} used deterministic fallback; this report is invalid evidence for a cross-encoder reranker claim.`
    );
  } else if (candidate.metadata.fallbackDetected !== false) {
    warnings.push(
      `${candidate.strategy} does not explicitly prove fallbackDetected=false; this report is not valid evidence for a cross-encoder reranker claim.`
    );
  }
  return warnings;
}

function evaluateCriteria(
  criteria: ClaimCriteria,
  ciByMetric: Map<string, { mean: number; low: number; high: number; excludesZero: boolean; direction: MetricDirection }>,
  tokenSummary?: Pick<RerankerClaimTokenSummary, 'baselineFirstHitTasks' | 'candidateFirstHitTasks' | 'pairedHitTasks'>
): CriteriaEvaluation[] {
  const evaluate = (metric: string, role: 'improvement' | 'nonRegression'): CriteriaEvaluation => {
    const ci = ciByMetric.get(metric);
    if (metric === 'tokensToFirstHit' && tokenSummary?.pairedHitTasks === 0) {
      return {
        metric,
        role,
        direction: 'ambiguous',
        mean: 0,
        pass: false,
        reason: 'no paired-hit tasks available for a tokensToFirstHit paired CI',
      };
    }
    if (!ci) {
      return { metric, role, direction: 'ambiguous', mean: 0, pass: false, reason: `metric ${metric} not present in report` };
    }
    const higherBetter = !LOWER_BETTER_METRICS.has(metric);
    const beneficialDir: MetricDirection = higherBetter ? 'positive' : 'negative';
    const adverseDir: MetricDirection = higherBetter ? 'negative' : 'positive';
    const beneficialMean = higherBetter ? ci.mean > 0 : ci.mean < 0;
    const ciBeneficial = ci.direction === beneficialDir;
    const ciAdverse = ci.direction === adverseDir;
    const floor = criteria.minEffectSize?.[metric];
    const effectOk = floor === undefined || Math.abs(ci.mean) >= floor;

    let pass: boolean;
    let reason: string;
    if (metric === 'tokensToFirstHit' && tokenSummary) {
      if (tokenSummary.candidateFirstHitTasks < tokenSummary.baselineFirstHitTasks) {
        return {
          metric,
          role,
          direction: 'ambiguous',
          mean: ci.mean,
          pass: false,
          reason: 'candidate first-hit rate regressed; paired-token survivors cannot support the claim',
        };
      }
    }

    if (role === 'improvement') {
      const improves = criteria.requireCiExcludesZero ? ciBeneficial : beneficialMean;
      pass = improves && effectOk;
      reason = !improves
        ? (criteria.requireCiExcludesZero
          ? `paired CI does not exclude zero in the beneficial (${beneficialDir}) direction`
          : `mean diff is not in the beneficial direction`)
        : !effectOk
          ? `mean |${ci.mean.toFixed(3)}| is below the effect-size floor ${floor}`
          : 'improves with paired CI excluding zero';
    } else {
      const regressed = criteria.requireCiExcludesZero ? ciAdverse : higherBetter ? ci.mean < 0 : ci.mean > 0;
      pass = !regressed;
      reason = regressed
        ? (criteria.requireCiExcludesZero
          ? `regressed: paired CI excludes zero in the adverse (${adverseDir}) direction`
          : 'regressed on the mean')
        : 'no regression';
    }
    return { metric, role, direction: ci.direction, mean: ci.mean, pass, reason };
  };

  return [
    ...criteria.improvementMetrics.map((m) => evaluate(m, 'improvement')),
    ...criteria.nonRegressionMetrics.map((m) => evaluate(m, 'nonRegression')),
  ];
}

export function buildRerankerClaimReport(input: {
  baseline: EvaluationReport;
  candidate: EvaluationReport;
  baselineStrategy?: string;
  candidateStrategy?: string;
  criteria?: ClaimCriteria;
  nBoot?: number;
}): RerankerClaimReport {
  assertCompatibleReports(input.baseline, input.candidate);
  const baseline = selectSummary(input.baseline, input.baselineStrategy);
  const candidate = selectSummary(input.candidate, input.candidateStrategy);
  assertSameTaskSet(baseline, candidate);
  const criteria = input.criteria ?? DEFAULT_RERANKER_CLAIM_CRITERIA;
  const baselineByTask = new Map(baseline.results.map((r) => [r.taskId, r]));
  const pairs = candidate.results
    .map((c) => ({ candidate: c, baseline: baselineByTask.get(c.taskId) }))
    .filter((p): p is { candidate: EvalResult; baseline: EvalResult } => Boolean(p.baseline));

  if (pairs.length === 0) {
    throw new Error(`no paired tasks between ${baseline.strategy} and ${candidate.strategy}`);
  }

  const nBoot = input.nBoot ?? 10_000;
  const metricCIs: RerankerClaimMetricCI[] = CLAIM_METRICS.map((metric) => {
    const candidateValues = pairs.map((p) => p.candidate.metrics[metric]);
    const baselineValues = pairs.map((p) => p.baseline.metrics[metric]);
    const ci = pairedDiffCI(candidateValues, baselineValues, metric, nBoot);
    return { metric, ...ci, direction: directionOf(ci.low, ci.high) };
  });

  const pairedTokenDiffs: number[] = [];
  let baselineFirstHitTasks = 0;
  let candidateFirstHitTasks = 0;
  let candidateReducedTokens = 0;
  let candidateIncreasedTokens = 0;
  let candidateTiedTokens = 0;
  const baselinePairedTokens: number[] = [];
  const candidatePairedTokens: number[] = [];

  for (const pair of pairs) {
    const baselineToken = finiteToken(pair.baseline);
    const candidateToken = finiteToken(pair.candidate);
    if (baselineToken !== null) baselineFirstHitTasks++;
    if (candidateToken !== null) candidateFirstHitTasks++;
    if (baselineToken === null || candidateToken === null) continue;
    baselinePairedTokens.push(baselineToken);
    candidatePairedTokens.push(candidateToken);
    const diff = candidateToken - baselineToken;
    pairedTokenDiffs.push(diff);
    if (diff < 0) candidateReducedTokens++;
    else if (diff > 0) candidateIncreasedTokens++;
    else candidateTiedTokens++;
  }

  const tokenDiffCI: RerankerClaimTokenCI | null = pairedTokenDiffs.length > 0
    ? (() => {
      const ci = pairedDiffCI(candidatePairedTokens, baselinePairedTokens, 'tokensToFirstHit', nBoot);
      return { ...ci, direction: directionOf(ci.low, ci.high) };
    })()
    : null;
  const tokenSummary: RerankerClaimTokenSummary = {
    pairedTasks: pairs.length,
    baselineFirstHitTasks,
    candidateFirstHitTasks,
    baselineFirstHitRate: baselineFirstHitTasks / pairs.length,
    candidateFirstHitRate: candidateFirstHitTasks / pairs.length,
    pairedHitTasks: pairedTokenDiffs.length,
    tasksExcludedOneSidedMiss: baselineFirstHitTasks + candidateFirstHitTasks - 2 * pairedTokenDiffs.length,
    baselineMeanTokensToFirstHit: mean(baselinePairedTokens),
    candidateMeanTokensToFirstHit: mean(candidatePairedTokens),
    meanTokenDiffOnPairedHits: mean(pairedTokenDiffs),
    tokenDiffCI,
    candidateReducedTokens,
    candidateIncreasedTokens,
    candidateTiedTokens,
  };

  const ciByMetric = new Map<string, { mean: number; low: number; high: number; excludesZero: boolean; direction: MetricDirection }>();
  for (const ci of metricCIs) ciByMetric.set(ci.metric, ci);
  if (tokenDiffCI) ciByMetric.set('tokensToFirstHit', tokenDiffCI);
  const criteriaEvaluation = evaluateCriteria(criteria, ciByMetric, tokenSummary);

  const warnings = reportWarnings(candidate);
  const valid = warnings.length === 0;
  const improvementPass = criteriaEvaluation.filter((e) => e.role === 'improvement').every((e) => e.pass);
  const nonRegPass = criteriaEvaluation.filter((e) => e.role === 'nonRegression').every((e) => e.pass);
  const verdict: RegimeVerdict = !valid
    ? 'inconclusive'
    : !nonRegPass || !improvementPass
      ? 'debunk'
      : 'confirm';

  return {
    baselineStrategy: baseline.strategy,
    candidateStrategy: candidate.strategy,
    valid,
    warnings,
    pairedTasks: pairs.length,
    verdict,
    criteria,
    criteriaEvaluation,
    metricCIs,
    tokenSummary,
  };
}

function loadReport(path: string): EvaluationReport {
  return JSON.parse(readFileSync(path, 'utf-8')) as EvaluationReport;
}

function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;
}

function printText(report: RerankerClaimReport): void {
  console.log(`${report.candidateStrategy} minus ${report.baselineStrategy}`);
  console.log(`Verdict: ${report.verdict}`);
  console.log(`Valid evidence: ${report.valid ? 'yes' : 'no'}`);
  if (report.warnings.length) {
    console.log('\nWarnings:');
    for (const warning of report.warnings) console.log(`  - ${warning}`);
  }
  console.log(`Paired tasks: ${report.pairedTasks}`);
  console.log('\nCriteria evaluation:');
  for (const e of report.criteriaEvaluation) {
    console.log(`  [${e.role === 'improvement' ? 'IMPROVE' : 'NO-REG'}] ${e.metric.padEnd(10)} ${e.pass ? 'PASS' : 'fail'} (${e.direction}, mean ${formatSigned(e.mean)}) — ${e.reason}`);
  }
  console.log('\nMetric paired CIs:');
  for (const ci of report.metricCIs) {
    console.log(`  ${ci.metric.padEnd(10)} ${formatSigned(ci.mean)} [${formatSigned(ci.low)}, ${formatSigned(ci.high)}]${ci.excludesZero ? ' *' : ''}`);
  }
  const t = report.tokenSummary;
  console.log('\nTokens to first hit:');
  console.log(`  first-hit rate: baseline ${t.baselineFirstHitTasks}/${t.pairedTasks} (${t.baselineFirstHitRate.toFixed(3)}), candidate ${t.candidateFirstHitTasks}/${t.pairedTasks} (${t.candidateFirstHitRate.toFixed(3)})`);
  console.log(`  paired-hit tasks: ${t.pairedHitTasks} (excluded ${t.tasksExcludedOneSidedMiss} one-sided misses)`);
  if (t.pairedHitTasks > 0) {
    console.log(`  mean tokens: baseline ${t.baselineMeanTokensToFirstHit?.toFixed(1)}, candidate ${t.candidateMeanTokensToFirstHit?.toFixed(1)}, diff ${t.meanTokenDiffOnPairedHits?.toFixed(1)}`);
    if (t.tokenDiffCI) {
      console.log(`  token diff CI: ${formatSigned(t.tokenDiffCI.mean)} [${formatSigned(t.tokenDiffCI.low)}, ${formatSigned(t.tokenDiffCI.high)}]${t.tokenDiffCI.excludesZero ? ' *' : ''}`);
    }
    console.log(`  candidate reduced/increased/tied: ${t.candidateReducedTokens}/${t.candidateIncreasedTokens}/${t.candidateTiedTokens}`);
  }
}

/** CI exit code: 0 for usable evidence, optionally requiring a confirmed claim. */
export function reportExitCode(
  report: RerankerClaimReport,
  options: { requireConfirm?: boolean } = {}
): number {
  if (!report.valid) return 1;
  if (options.requireConfirm && report.verdict !== 'confirm') return 1;
  return 0;
}

function readArgValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseCli(argv: string[]): {
  baselinePath: string;
  candidatePath: string;
  baselineStrategy?: string;
  candidateStrategy?: string;
  manifestPath?: string;
  requireConfirm: boolean;
  json: boolean;
} {
  let baselinePath = '';
  let candidatePath = '';
  let baselineStrategy: string | undefined;
  let candidateStrategy: string | undefined;
  let manifestPath: string | undefined;
  let requireConfirm = false;
  let json = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--baseline') baselinePath = readArgValue(argv, i++, arg);
    else if (arg === '--candidate') candidatePath = readArgValue(argv, i++, arg);
    else if (arg === '--baseline-strategy') baselineStrategy = readArgValue(argv, i++, arg);
    else if (arg === '--candidate-strategy') candidateStrategy = readArgValue(argv, i++, arg);
    else if (arg === '--manifest') manifestPath = readArgValue(argv, i++, arg);
    else if (arg === '--require-confirm') requireConfirm = true;
    else if (arg === '--json') json = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    else positional.push(arg);
  }
  baselinePath ||= positional[0] ?? '';
  candidatePath ||= positional[1] ?? '';
  if (!baselinePath || !candidatePath) {
    throw new Error('Usage: npx tsx benchmarks/reranker-claim-report.ts --baseline /tmp/plain.json --candidate /tmp/reranked.json [--manifest benchmarks/claims/reranker-reliability.json] [--require-confirm] [--json]');
  }
  return { baselinePath, candidatePath, baselineStrategy, candidateStrategy, manifestPath, requireConfirm, json };
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  try {
    const options = parseCli(process.argv.slice(2));
    const criteria = options.manifestPath
      ? (() => {
        const manifest = loadClaimManifest(options.manifestPath);
        if (!manifest.claimCriteria) {
          throw new Error(`${options.manifestPath}: claimCriteria is required when --manifest is used for report evaluation`);
        }
        return manifest.claimCriteria;
      })()
      : undefined;
    const report = buildRerankerClaimReport({
      baseline: loadReport(options.baselinePath),
      candidate: loadReport(options.candidatePath),
      baselineStrategy: options.baselineStrategy,
      candidateStrategy: options.candidateStrategy,
      criteria,
    });
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printText(report);
    const code = reportExitCode(report, { requireConfirm: options.requireConfirm });
    if (code !== 0) {
      console.error(`\nReport did not satisfy the requested claim gate (valid: ${report.valid}, verdict: ${report.verdict}). Aborting with exit code ${code}.`);
      process.exit(code);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
