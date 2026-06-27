import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export type ClaimStatus = 'candidate' | 'pre_registered' | 'running' | 'done';
export type ClaimVerdict = 'confirm' | 'debunk' | 'nuance' | 'inconclusive' | 'pending';

export interface PriorArtReference {
  title: string;
  url?: string;
  note: string;
}

export interface ClaimDataset {
  name: string;
  corpus: string;
  taskSource: string;
  realismRole: 'positive_control' | 'real_data' | 'ablation' | 'scale_case';
}

export interface ClaimCommand {
  name: string;
  command: string;
  expectedOutput: string;
}

export interface ClaimArtifact {
  path: string;
  purpose: string;
  committed: boolean;
}

/**
 * Machine-checkable operationalization of the claim. The prose `killCriterion`
 * is for humans; this block is what the report evaluates to emit a verdict, so
 * that "reliably" is not left to a point-estimate eyeball.
 */
export interface ClaimCriteria {
  /** Metrics the candidate must improve (mean in the beneficial direction). */
  improvementMetrics: string[];
  /** Metrics the candidate must not regress on (e.g. recallAt10). */
  nonRegressionMetrics: string[];
  /** Require the paired-CI lower bound to exclude zero, not just the mean. */
  requireCiExcludesZero: boolean;
  /** Optional mean-diff floor per metric (e.g. { hitsAt1: 0.02 }). */
  minEffectSize?: Record<string, number>;
  /** How per-regime verdicts combine into the overall claim verdict. */
  perRegimeAggregation: 'all' | 'majority';
}

export interface ClaimManifest {
  schemaVersion: 1;
  id: string;
  title: string;
  status: ClaimStatus;
  claim: string;
  scope: string;
  priorArt: PriorArtReference[];
  metrics: string[];
  positiveControl: {
    hypothesis: string;
    command: string;
    passCriterion: string;
  };
  realismGate: {
    regime: string;
    command: string;
    passCriterion: string;
  };
  killCriterion: string;
  /** Machine-checkable criteria; required once status passes 'candidate'. */
  claimCriteria?: ClaimCriteria;
  datasets: ClaimDataset[];
  commands: ClaimCommand[];
  artifacts: ClaimArtifact[];
  verdict: {
    outcome: ClaimVerdict;
    summary: string;
  };
}

export interface ClaimValidationResult {
  valid: boolean;
  errors: string[];
}

const VALID_STATUSES = new Set<ClaimStatus>(['candidate', 'pre_registered', 'running', 'done']);
const VALID_VERDICTS = new Set<ClaimVerdict>(['confirm', 'debunk', 'nuance', 'inconclusive', 'pending']);
const VALID_DATASET_ROLES = new Set<ClaimDataset['realismRole']>([
  'positive_control',
  'real_data',
  'ablation',
  'scale_case',
]);

const VALID_AGGREGATIONS = new Set<ClaimCriteria['perRegimeAggregation']>(['all', 'majority']);

/** Statuses at which a prose-only kill criterion is no longer acceptable. */
const MACHINE_CHECK_REQUIRED = new Set<ClaimStatus>(['pre_registered', 'running', 'done']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function pushMissing(errors: string[], source: string, field: string): void {
  errors.push(`${source}: ${field} must be a non-empty string`);
}

function requireText(
  errors: string[],
  source: string,
  record: Record<string, unknown>,
  field: string
): void {
  if (!isNonEmptyString(record[field])) pushMissing(errors, source, field);
}

function requireTextArray(
  errors: string[],
  source: string,
  record: Record<string, unknown>,
  field: string
): void {
  const value = record[field];
  if (!Array.isArray(value) || value.length === 0 || !value.every(isNonEmptyString)) {
    errors.push(`${source}: ${field} must be a non-empty string array`);
  }
}

/** Like requireTextArray but uses the dot style for nested criteria fields. */
function requireMetricArray(
  errors: string[],
  label: string,
  record: Record<string, unknown>,
  field: string
): void {
  const value = record[field];
  if (!Array.isArray(value) || value.length === 0 || !value.every(isNonEmptyString)) {
    errors.push(`${label}.${field} must be a non-empty string array`);
  }
}

function validatePriorArt(errors: string[], source: string, value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${source}: priorArt must contain at least one reference`);
    return;
  }

  value.forEach((entry, index) => {
    const label = `${source}: priorArt[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${label} must be an object`);
      return;
    }
    requireText(errors, label, entry, 'title');
    requireText(errors, label, entry, 'note');
    if (entry.url !== undefined && !isNonEmptyString(entry.url)) {
      errors.push(`${label}.url must be a non-empty string when present`);
    }
  });
}

function validateControl(
  errors: string[],
  source: string,
  record: Record<string, unknown>,
  field: 'positiveControl' | 'realismGate'
): void {
  const value = record[field];
  if (!isRecord(value)) {
    errors.push(`${source}: ${field} must be an object`);
    return;
  }

  if (field === 'positiveControl') {
    requireText(errors, `${source}: ${field}`, value, 'hypothesis');
  } else {
    requireText(errors, `${source}: ${field}`, value, 'regime');
  }
  requireText(errors, `${source}: ${field}`, value, 'command');
  requireText(errors, `${source}: ${field}`, value, 'passCriterion');
}

function validateDatasets(errors: string[], source: string, value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${source}: datasets must contain at least one dataset`);
    return;
  }

  let hasPositiveControl = false;
  let hasRealData = false;

  value.forEach((entry, index) => {
    const label = `${source}: datasets[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${label} must be an object`);
      return;
    }
    requireText(errors, label, entry, 'name');
    requireText(errors, label, entry, 'corpus');
    requireText(errors, label, entry, 'taskSource');
    if (!VALID_DATASET_ROLES.has(entry.realismRole as ClaimDataset['realismRole'])) {
      errors.push(`${label}.realismRole must be one of: ${[...VALID_DATASET_ROLES].join(', ')}`);
    }
    if (entry.realismRole === 'positive_control') hasPositiveControl = true;
    if (entry.realismRole === 'real_data') hasRealData = true;
  });

  if (!hasPositiveControl) {
    errors.push(`${source}: datasets must include a positive_control dataset`);
  }
  if (!hasRealData) {
    errors.push(`${source}: datasets must include a real_data dataset`);
  }
}

function validateCommands(errors: string[], source: string, value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${source}: commands must contain at least one command`);
    return;
  }

  value.forEach((entry, index) => {
    const label = `${source}: commands[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${label} must be an object`);
      return;
    }
    requireText(errors, label, entry, 'name');
    requireText(errors, label, entry, 'command');
    requireText(errors, label, entry, 'expectedOutput');
  });
}

function validateArtifacts(errors: string[], source: string, value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${source}: artifacts must contain at least one artifact`);
    return;
  }

  value.forEach((entry, index) => {
    const label = `${source}: artifacts[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${label} must be an object`);
      return;
    }
    requireText(errors, label, entry, 'path');
    requireText(errors, label, entry, 'purpose');
    if (typeof entry.committed !== 'boolean') {
      errors.push(`${label}.committed must be a boolean`);
    }
    if (entry.committed === false && isNonEmptyString(entry.path) && !entry.path.startsWith('/tmp/')) {
      errors.push(`${label}.path for generated artifacts must be under /tmp`);
    }
    if (entry.committed === true && isNonEmptyString(entry.path) && !existsSync(entry.path)) {
      errors.push(`${label}.path for committed artifacts must exist`);
    }
  });
}

function validateVerdict(errors: string[], source: string, value: unknown): void {
  if (!isRecord(value)) {
    errors.push(`${source}: verdict must be an object`);
    return;
  }
  if (!VALID_VERDICTS.has(value.outcome as ClaimVerdict)) {
    errors.push(`${source}: verdict.outcome must be one of: ${[...VALID_VERDICTS].join(', ')}`);
  }
  requireText(errors, `${source}: verdict`, value, 'summary');
}

function validateClaimCriteria(errors: string[], source: string, value: unknown): void {
  const label = `${source}: claimCriteria`;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  requireMetricArray(errors, label, value, 'improvementMetrics');
  requireMetricArray(errors, label, value, 'nonRegressionMetrics');
  if (typeof value.requireCiExcludesZero !== 'boolean') {
    errors.push(`${label}.requireCiExcludesZero must be a boolean`);
  }
  if (value.minEffectSize !== undefined) {
    const minEffectSize = value.minEffectSize;
    if (!isRecord(minEffectSize) || Object.keys(minEffectSize).length === 0) {
      errors.push(`${label}.minEffectSize must be a non-empty metric→number map when present`);
    } else {
      for (const [metric, floor] of Object.entries(minEffectSize)) {
        if (typeof floor !== 'number' || !Number.isFinite(floor)) {
          errors.push(`${label}.minEffectSize.${metric} must be a finite number`);
        }
      }
    }
  }
  if (!VALID_AGGREGATIONS.has(value.perRegimeAggregation as ClaimCriteria['perRegimeAggregation'])) {
    errors.push(`${label}.perRegimeAggregation must be one of: ${[...VALID_AGGREGATIONS].join(', ')}`);
  }
}

export function validateClaimManifest(value: unknown, source = 'claim manifest'): ClaimValidationResult {
  const errors: string[] = [];

  if (!isRecord(value)) {
    return { valid: false, errors: [`${source}: manifest must be an object`] };
  }

  if (value.schemaVersion !== 1) {
    errors.push(`${source}: schemaVersion must be 1`);
  }
  requireText(errors, source, value, 'id');
  requireText(errors, source, value, 'title');
  if (!VALID_STATUSES.has(value.status as ClaimStatus)) {
    errors.push(`${source}: status must be one of: ${[...VALID_STATUSES].join(', ')}`);
  }
  requireText(errors, source, value, 'claim');
  requireText(errors, source, value, 'scope');
  requireTextArray(errors, source, value, 'metrics');
  validatePriorArt(errors, source, value.priorArt);
  validateControl(errors, source, value, 'positiveControl');
  validateControl(errors, source, value, 'realismGate');
  requireText(errors, source, value, 'killCriterion');
  if (value.claimCriteria === undefined) {
    if (MACHINE_CHECK_REQUIRED.has(value.status as ClaimStatus)) {
      errors.push(
        `${source}: claimCriteria is required once a claim is pre_registered, running, or done (prose-only kill criteria are not enforceable)`
      );
    }
  } else {
    validateClaimCriteria(errors, source, value.claimCriteria);
  }
  validateDatasets(errors, source, value.datasets);
  validateCommands(errors, source, value.commands);
  validateArtifacts(errors, source, value.artifacts);
  validateVerdict(errors, source, value.verdict);

  return { valid: errors.length === 0, errors };
}

export function loadClaimManifest(path: string): ClaimManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Unable to read claim manifest at ${path}: ${detail}`);
  }

  const validation = validateClaimManifest(parsed, path);
  if (!validation.valid) {
    throw new Error(validation.errors.join('\n'));
  }
  return parsed as ClaimManifest;
}

interface CliOptions {
  manifest?: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--manifest') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--manifest requires a path');
      options.manifest = value;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!options.manifest && !arg.startsWith('--')) {
      options.manifest = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.manifest) throw new Error('Provide a claim manifest path');
  return options;
}

function printUsage(): void {
  console.log(`Usage:
  npx tsx benchmarks/claim-protocol.ts benchmarks/claims/reranker-reliability.json
  npx tsx benchmarks/claim-protocol.ts --manifest benchmarks/claims/reranker-reliability.json --json`);
}

function runCli(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    const manifest = loadClaimManifest(options.manifest!);
    if (options.json) {
      console.log(JSON.stringify({ passed: true, id: manifest.id, status: manifest.status }, null, 2));
    } else {
      console.log(`Claim manifest OK: ${manifest.id} (${manifest.status})`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
