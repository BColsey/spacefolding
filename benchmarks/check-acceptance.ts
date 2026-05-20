/**
 * Check Spacefolding acceptance-gate JSON outputs.
 *
 * Usage:
 *   npx tsx benchmarks/check-acceptance.ts \
 *     --retrieval-json /tmp/spacefolding-eval.json \
 *     --e2e-json /tmp/spacefolding-e2e.json
 */

import { readFileSync } from 'node:fs';

interface CliOptions {
  retrievalJson?: string;
  e2eJson?: string;
  json: boolean;
}

interface GateCheck {
  name: string;
  passed: boolean;
  actual: number | boolean | string;
  expected: string;
}

interface StrategySummary {
  strategy: string;
  averages: Record<string, number>;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--retrieval-json' || arg === '--retrieval') && argv[i + 1]) {
      options.retrievalJson = argv[++i];
    } else if ((arg === '--e2e-json' || arg === '--e2e') && argv[i + 1]) {
      options.e2eJson = argv[++i];
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  if (!options.retrievalJson && !options.e2eJson) {
    throw new Error('Provide --retrieval-json, --e2e-json, or both');
  }

  return options;
}

function printUsage(): void {
  console.log(`Usage:
  npx tsx benchmarks/check-acceptance.ts \\
    --retrieval-json /tmp/spacefolding-eval.json \\
    --e2e-json /tmp/spacefolding-e2e.json

Checks:
  retrieval: structural beats keyword on R@10, NDCG@10, and MRR
  e2e: recall, precision, and average tokens improve vs current hybrid
  e2e: no task returns more tokens than the full codebase`);
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function strategyByName(data: any, name: string): StrategySummary | undefined {
  return data.strategies?.find((summary: StrategySummary) => summary.strategy === name);
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function addRetrievalChecks(checks: GateCheck[], data: any): void {
  const keyword = strategyByName(data, 'keyword');
  const structural = strategyByName(data, 'structural');
  if (!keyword || !structural) {
    checks.push({
      name: 'retrieval.structural_and_keyword_present',
      passed: false,
      actual: false,
      expected: 'JSON includes keyword and structural strategy summaries',
    });
    return;
  }

  const metrics = [
    ['recallAt10', 'R@10'],
    ['ndcgAt10', 'NDCG@10'],
    ['mrr', 'MRR'],
  ] as const;

  for (const [field, label] of metrics) {
    const delta = structural.averages[field] - keyword.averages[field];
    checks.push({
      name: `retrieval.${field}`,
      passed: delta > 0,
      actual: rounded(delta),
      expected: `structural ${label} > keyword ${label}`,
    });
  }

  if (data.successGate && typeof data.successGate.structuralBeatsKeyword === 'boolean') {
    checks.push({
      name: 'retrieval.success_gate',
      passed: data.successGate.structuralBeatsKeyword,
      actual: data.successGate.structuralBeatsKeyword,
      expected: 'evaluate.ts successGate.structuralBeatsKeyword is true',
    });
  }
}

function addE2EChecks(checks: GateCheck[], data: any): void {
  const summary = data.summary;
  if (!summary) {
    checks.push({
      name: 'e2e.summary_present',
      passed: false,
      actual: false,
      expected: 'JSON includes an E2E summary',
    });
    return;
  }

  checks.push({
    name: 'e2e.recall_vs_current',
    passed: summary.averageRecallVsCurrent > 0,
    actual: rounded(summary.averageRecallVsCurrent ?? Number.NaN),
    expected: 'averageRecallVsCurrent > 0',
  });
  checks.push({
    name: 'e2e.precision_vs_current',
    passed: summary.averagePrecisionVsCurrent > 0,
    actual: rounded(summary.averagePrecisionVsCurrent ?? Number.NaN),
    expected: 'averagePrecisionVsCurrent > 0',
  });
  checks.push({
    name: 'e2e.tokens_vs_current',
    passed: summary.averageTokensVsCurrent > 0,
    actual: rounded(summary.averageTokensVsCurrent ?? Number.NaN),
    expected: 'averageTokensVsCurrent > 0',
  });
  checks.push({
    name: 'e2e.no_task_exceeds_codebase_tokens',
    passed: Array.isArray(summary.tasksReturningMoreThanCodebase)
      && summary.tasksReturningMoreThanCodebase.length === 0,
    actual: Array.isArray(summary.tasksReturningMoreThanCodebase)
      ? summary.tasksReturningMoreThanCodebase.join(', ') || 'none'
      : 'missing',
    expected: 'tasksReturningMoreThanCodebase is empty',
  });

  if (typeof summary.averageTokens === 'number' && typeof summary.totalCodebaseTokens === 'number') {
    checks.push({
      name: 'e2e.average_tokens_below_codebase',
      passed: summary.averageTokens < summary.totalCodebaseTokens,
      actual: rounded(summary.averageTokens),
      expected: `averageTokens < totalCodebaseTokens (${Math.round(summary.totalCodebaseTokens)})`,
    });
  }
}

function printText(checks: GateCheck[]): void {
  const passed = checks.every((check) => check.passed);
  console.log(`Acceptance gate: ${passed ? 'PASS' : 'FAIL'}`);
  for (const check of checks) {
    const marker = check.passed ? 'PASS' : 'FAIL';
    console.log(`${marker} ${check.name}: actual=${check.actual} expected=${check.expected}`);
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const checks: GateCheck[] = [];

  if (options.retrievalJson) addRetrievalChecks(checks, readJson(options.retrievalJson));
  if (options.e2eJson) addE2EChecks(checks, readJson(options.e2eJson));

  const passed = checks.every((check) => check.passed);
  const output = { passed, checks };
  if (options.json) console.log(JSON.stringify(output, null, 2));
  else printText(checks);

  if (!passed) process.exit(1);
}

main();
