/**
 * Check Spacefolding acceptance-gate JSON outputs.
 *
 * Usage:
 *   npx tsx benchmarks/check-acceptance.ts \
 *     --retrieval-json /tmp/spacefolding-eval.json \
 *     --e2e-json /tmp/spacefolding-e2e.json
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CliOptions {
  retrievalJson?: string;
  e2eJson?: string;
  json: boolean;
}

export interface GateCheck {
  name: string;
  passed: boolean;
  actual: number | boolean | string;
  expected: string;
}

export interface AcceptanceReport {
  passed: boolean;
  checks: GateCheck[];
}

export interface AcceptanceInputs {
  retrieval?: unknown;
  e2e?: unknown;
}

interface LoadedJson {
  data?: unknown;
  check?: GateCheck;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--retrieval-json' || arg === '--retrieval') {
      if (!argv[i + 1]) throw new Error(`${arg} requires a JSON path`);
      options.retrievalJson = argv[++i];
    } else if (arg === '--e2e-json' || arg === '--e2e') {
      if (!argv[i + 1]) throw new Error(`${arg} requires a JSON path`);
      options.e2eJson = argv[++i];
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.retrievalJson && !options.e2eJson) {
    throw new Error('Provide --retrieval-json, --e2e-json, or both');
  }

  return options;
}

export function printUsage(): void {
  console.log(`Usage:
  npx tsx benchmarks/check-acceptance.ts \\
    --retrieval-json /tmp/spacefolding-eval.json \\
    --e2e-json /tmp/spacefolding-e2e.json

Checks:
  retrieval: exhaustive structural ranking beats keyword on R@10, NDCG@10, and MRR
  e2e: focused retrieval reaches >=0.95 average recall, >=0.35 precision, and <=13k average tokens
  e2e: recall, precision, and average tokens improve vs current hybrid
  e2e: no task returns more tokens than the full codebase`);
}

function readJson(path: string, label: 'retrieval' | 'e2e'): LoadedJson {
  try {
    return { data: JSON.parse(readFileSync(path, 'utf-8')) as unknown };
  } catch (err) {
    return {
      check: {
        name: `${label}.json_readable`,
        passed: false,
        actual: errorMessage(err),
        expected: `valid JSON file at ${path}`,
      },
    };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'non-finite number';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'object') return 'object';
  return typeof value;
}

function strategyByName(
  strategies: unknown[],
  name: 'keyword' | 'structural'
): Record<string, unknown> | undefined {
  return strategies.find((summary) => isRecord(summary) && summary.strategy === name) as
    | Record<string, unknown>
    | undefined;
}

function numericField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numericAverage(summary: Record<string, unknown>, field: string): number | undefined {
  return isRecord(summary.averages) ? numericField(summary.averages, field) : undefined;
}

function missingAverageMessage(
  strategyName: 'keyword' | 'structural',
  summary: Record<string, unknown> | undefined,
  field: string
): string | null {
  if (!summary) return `${strategyName} strategy summary`;
  if (!isRecord(summary.averages)) return `${strategyName}.averages`;
  if (numericField(summary.averages, field) === undefined) {
    return `${strategyName}.averages.${field}`;
  }
  return null;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function addNumericSummaryCheck(
  checks: GateCheck[],
  summary: Record<string, unknown>,
  name: string,
  field: string,
  predicate: (value: number) => boolean,
  expected: string
): void {
  const value = numericField(summary, field);
  checks.push({
    name,
    passed: value !== undefined && predicate(value),
    actual: value === undefined ? `missing/invalid: summary.${field}` : rounded(value),
    expected,
  });
}

export function addRetrievalChecks(checks: GateCheck[], data: unknown): void {
  if (!isRecord(data)) {
    checks.push({
      name: 'retrieval.root_object_present',
      passed: false,
      actual: describeValue(data),
      expected: 'retrieval JSON is an object',
    });
    return;
  }

  const strategies = data.strategies;
  if (!Array.isArray(strategies)) {
    checks.push({
      name: 'retrieval.strategies_present',
      passed: false,
      actual: describeValue(strategies),
      expected: 'top-level strategies array',
    });
  } else {
    const keyword = strategyByName(strategies, 'keyword');
    const structural = strategyByName(strategies, 'structural');
    const missingStrategies = [
      keyword ? null : 'keyword',
      structural ? null : 'structural',
    ].filter((strategy): strategy is string => strategy !== null);

    if (missingStrategies.length > 0) {
      checks.push({
        name: 'retrieval.strategy_summaries_present',
        passed: false,
        actual: `missing: ${missingStrategies.join(', ')}`,
        expected: 'keyword and structural strategy summaries present',
      });
    } else if (keyword && structural) {
      const metrics = [
        ['recallAt10', 'R@10'],
        ['ndcgAt10', 'NDCG@10'],
        ['mrr', 'MRR'],
      ] as const;

      for (const [field, label] of metrics) {
        const missingMetric = [
          missingAverageMessage('keyword', keyword, field),
          missingAverageMessage('structural', structural, field),
        ].filter((message): message is string => message !== null);

        if (missingMetric.length > 0) {
          checks.push({
            name: `retrieval.${field}`,
            passed: false,
            actual: `missing/invalid: ${missingMetric.join(', ')}`,
            expected: `numeric keyword and structural averages for ${label}`,
          });
          continue;
        }

        const keywordValue = numericAverage(keyword, field);
        const structuralValue = numericAverage(structural, field);
        if (keywordValue === undefined || structuralValue === undefined) continue;

        const delta = structuralValue - keywordValue;
        checks.push({
          name: `retrieval.${field}`,
          passed: delta > 0,
          actual: rounded(delta),
          expected: `structural ${label} > keyword ${label}`,
        });
      }
    }
  }

  if (!isRecord(data.successGate)) {
    checks.push({
      name: 'retrieval.success_gate_present',
      passed: false,
      actual: describeValue(data.successGate),
      expected: 'top-level successGate object',
    });
    return;
  }

  const structuralBeatsKeyword = data.successGate.structuralBeatsKeyword;
  checks.push({
    name: 'retrieval.success_gate',
    passed: structuralBeatsKeyword === true,
    actual: typeof structuralBeatsKeyword === 'boolean'
      ? structuralBeatsKeyword
      : `missing/invalid: successGate.structuralBeatsKeyword`,
    expected: 'successGate.structuralBeatsKeyword is true',
  });
}

export function addE2EChecks(checks: GateCheck[], data: unknown): void {
  if (!isRecord(data)) {
    checks.push({
      name: 'e2e.root_object_present',
      passed: false,
      actual: describeValue(data),
      expected: 'E2E JSON is an object',
    });
    return;
  }

  const summary = data.summary;
  if (!isRecord(summary)) {
    checks.push({
      name: 'e2e.summary_present',
      passed: false,
      actual: describeValue(summary),
      expected: 'top-level summary object',
    });
  } else {
    addNumericSummaryCheck(
      checks,
      summary,
      'e2e.recall_vs_current',
      'averageRecallVsCurrent',
      (value) => value > 0,
      'summary.averageRecallVsCurrent > 0'
    );
    addNumericSummaryCheck(
      checks,
      summary,
      'e2e.precision_vs_current',
      'averagePrecisionVsCurrent',
      (value) => value > 0,
      'summary.averagePrecisionVsCurrent > 0'
    );
    addNumericSummaryCheck(
      checks,
      summary,
      'e2e.tokens_vs_current',
      'averageTokensVsCurrent',
      (value) => value > 0,
      'summary.averageTokensVsCurrent > 0'
    );

    const oversizedTasks = summary.tasksReturningMoreThanCodebase;
    checks.push({
      name: 'e2e.no_task_exceeds_codebase_tokens',
      passed: Array.isArray(oversizedTasks) && oversizedTasks.length === 0,
      actual: Array.isArray(oversizedTasks)
        ? oversizedTasks.join(', ') || 'none'
        : describeValue(oversizedTasks),
      expected: 'summary.tasksReturningMoreThanCodebase is an empty array',
    });

    addNumericSummaryCheck(
      checks,
      summary,
      'e2e.focused_average_recall',
      'averageRecall',
      (value) => value >= 0.95,
      'summary.averageRecall >= 0.95'
    );
    addNumericSummaryCheck(
      checks,
      summary,
      'e2e.focused_average_precision',
      'averagePrecision',
      (value) => value >= 0.35,
      'summary.averagePrecision >= 0.35'
    );
    addNumericSummaryCheck(
      checks,
      summary,
      'e2e.focused_average_tokens',
      'averageTokens',
      (value) => value <= 13_000,
      'summary.averageTokens <= 13000'
    );

    const averageTokens = numericField(summary, 'averageTokens');
    const totalCodebaseTokens = numericField(summary, 'totalCodebaseTokens');
    checks.push({
      name: 'e2e.average_tokens_below_codebase',
      passed: averageTokens !== undefined
        && totalCodebaseTokens !== undefined
        && averageTokens < totalCodebaseTokens,
      actual: averageTokens === undefined || totalCodebaseTokens === undefined
        ? `missing/invalid: ${
          [
            averageTokens === undefined ? 'summary.averageTokens' : null,
            totalCodebaseTokens === undefined ? 'summary.totalCodebaseTokens' : null,
          ].filter((field): field is string => field !== null).join(', ')
        }`
        : rounded(averageTokens),
      expected: totalCodebaseTokens === undefined
        ? 'summary.averageTokens < summary.totalCodebaseTokens'
        : `summary.averageTokens < summary.totalCodebaseTokens (${Math.round(totalCodebaseTokens)})`,
    });
  }

  if (!isRecord(data.successGate)) {
    checks.push({
      name: 'e2e.success_gate_present',
      passed: false,
      actual: describeValue(data.successGate),
      expected: 'top-level successGate object',
    });
    return;
  }

  const focusedRetrievalPasses = data.successGate.focusedRetrievalPasses;
  checks.push({
    name: 'e2e.success_gate',
    passed: focusedRetrievalPasses === true,
    actual: typeof focusedRetrievalPasses === 'boolean'
      ? focusedRetrievalPasses
      : 'missing/invalid: successGate.focusedRetrievalPasses',
    expected: 'successGate.focusedRetrievalPasses is true',
  });
}

export function buildAcceptanceReport(inputs: AcceptanceInputs): AcceptanceReport {
  const checks: GateCheck[] = [];

  if (Object.prototype.hasOwnProperty.call(inputs, 'retrieval')) {
    addRetrievalChecks(checks, inputs.retrieval);
  }
  if (Object.prototype.hasOwnProperty.call(inputs, 'e2e')) {
    addE2EChecks(checks, inputs.e2e);
  }

  if (checks.length === 0) {
    checks.push({
      name: 'cli.inputs_present',
      passed: false,
      actual: 'none',
      expected: 'at least one of --retrieval-json or --e2e-json',
    });
  }

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
}

export function buildAcceptanceReportFromFiles(options: CliOptions): AcceptanceReport {
  const inputChecks: GateCheck[] = [];
  const inputs: AcceptanceInputs = {};

  if (options.retrievalJson) {
    const loaded = readJson(options.retrievalJson, 'retrieval');
    if (loaded.check) inputChecks.push(loaded.check);
    else inputs.retrieval = loaded.data;
  }

  if (options.e2eJson) {
    const loaded = readJson(options.e2eJson, 'e2e');
    if (loaded.check) inputChecks.push(loaded.check);
    else inputs.e2e = loaded.data;
  }

  const hasInputs = Object.keys(inputs).length > 0;
  const report = hasInputs
    ? buildAcceptanceReport(inputs)
    : { passed: true, checks: [] };
  const checks = [...inputChecks, ...report.checks];

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
}

export function formatTextReport(report: AcceptanceReport): string {
  const lines = [`Acceptance gate: ${report.passed ? 'PASS' : 'FAIL'}`];
  for (const check of report.checks) {
    const marker = check.passed ? 'PASS' : 'FAIL';
    lines.push(`${marker} ${check.name}: actual=${check.actual} expected=${check.expected}`);
  }
  return lines.join('\n');
}

function printReport(report: AcceptanceReport, json: boolean): void {
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatTextReport(report));
}

function main(argv = process.argv.slice(2)): void {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (err) {
    const report: AcceptanceReport = {
      passed: false,
      checks: [{
        name: 'cli.arguments',
        passed: false,
        actual: errorMessage(err),
        expected: 'valid check-acceptance arguments',
      }],
    };
    printReport(report, argv.includes('--json'));
    if (!argv.includes('--json')) printUsage();
    process.exit(1);
  }

  const report = buildAcceptanceReportFromFiles(options);
  printReport(report, options.json);

  if (!report.passed) process.exit(1);
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) main();
