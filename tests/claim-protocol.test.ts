import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadClaimManifest,
  validateClaimManifest,
  type ClaimCriteria,
  type ClaimManifest,
} from '../benchmarks/claim-protocol.ts';

function validClaimCriteria(): ClaimCriteria {
  return {
    improvementMetrics: ['hitsAt1', 'tokensToFirstHit'],
    nonRegressionMetrics: ['recallAt10'],
    requireCiExcludesZero: true,
    minEffectSize: { hitsAt1: 0.02 },
    perRegimeAggregation: 'all',
  };
}

function validManifest(): ClaimManifest {
  return {
    schemaVersion: 1,
    id: 'claim-1',
    title: 'Rerankers improve code localization',
    status: 'candidate',
    claim: 'Cross-encoder rerankers improve code localization.',
    scope: 'Repository-level file localization, not edit success.',
    priorArt: [{
      title: 'Prior work placeholder',
      note: 'Replace with primary citations during candidate discovery.',
    }],
    metrics: ['hitsAt1', 'recallAt10'],
    positiveControl: {
      hypothesis: 'An oracle reranker should improve Hits@1.',
      command: 'npx tsx benchmarks/evaluate.ts --json > /tmp/control.json',
      passCriterion: 'Hits@1 improves without Recall@10 regression.',
    },
    realismGate: {
      regime: 'Commit-derived real repositories.',
      command: 'npx tsx benchmarks/evaluate.ts --json > /tmp/realism.json',
      passCriterion: 'The effect survives real-data validation.',
    },
    killCriterion: 'Debunk if the effect fails on real commit-derived tasks.',
    datasets: [
      {
        name: 'control',
        corpus: '/path/to/corpus',
        taskSource: '/tmp/control-tasks.json',
        realismRole: 'positive_control',
      },
      {
        name: 'realism',
        corpus: '/path/to/corpus',
        taskSource: '/tmp/realism-tasks.json',
        realismRole: 'real_data',
      },
    ],
    commands: [{
      name: 'run-realism',
      command: 'npx tsx benchmarks/evaluate.ts --json > /tmp/realism.json',
      expectedOutput: '/tmp/realism.json',
    }],
    artifacts: [
      {
        path: '/tmp/realism.json',
        purpose: 'Generated realism-gate result.',
        committed: false,
      },
      {
        path: 'README.md',
        purpose: 'Committed final verdict.',
        committed: true,
      },
    ],
    verdict: {
      outcome: 'pending',
      summary: 'Not run yet.',
    },
  };
}

describe('claim protocol', () => {
  it('accepts a complete manifest with positive-control and real-data datasets', () => {
    const result = validateClaimManifest(validManifest(), 'test-manifest');

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('loads the checked-in reranker reliability manifest', () => {
    const manifest = loadClaimManifest('benchmarks/claims/reranker-reliability.json');

    expect(manifest.id).toBe('2026-06-reranker-reliability');
    expect(manifest.status).toBe('candidate');
    expect(manifest.verdict.outcome).toBe('pending');
  });

  it('documents explicit reranker benchmark arms without env-var selection', () => {
    const manifest = loadClaimManifest('benchmarks/claims/reranker-reliability.json');
    const commands = [
      manifest.positiveControl.command,
      manifest.realismGate.command,
      ...manifest.commands.map((command) => command.command),
    ].join('\n');

    expect(commands).toContain('--strategy structural-plain');
    expect(commands).toContain('--strategy structural-rerank-deterministic');
    expect(commands).toContain('--strategy structural-rerank-cross-encoder');
    expect(commands).toContain('--strategy structural-rerank-oracle');
    expect(commands).not.toContain('RERANKER_PROVIDER');
  });

  it('passes manifest criteria into every checked-in reranker claim report command', () => {
    const manifest = loadClaimManifest('benchmarks/claims/reranker-reliability.json');
    const reportCommands = manifest.commands
      .filter((command) => command.name.includes('report'))
      .map((command) => command.command);

    expect(reportCommands.length).toBeGreaterThan(0);
    for (const command of reportCommands) {
      expect(command).toContain('benchmarks/reranker-claim-report.ts');
      expect(command).toContain('--manifest benchmarks/claims/reranker-reliability.json');
      expect(command).toContain('--require-confirm');
    }
    expect(reportCommands.join('\n')).not.toContain('/tmp/spacefolding-reranker-control-tasks.json');
  });

  it('rejects manifests without the mandatory realism-gate spine', () => {
    const manifest = validManifest() as unknown as Record<string, unknown>;
    manifest.positiveControl = {};
    manifest.realismGate = {};
    manifest.killCriterion = '';
    manifest.datasets = [{
      name: 'ablation-only',
      corpus: '/path/to/corpus',
      taskSource: '/tmp/tasks.json',
      realismRole: 'ablation',
    }];

    const result = validateClaimManifest(manifest, 'bad-manifest');

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('bad-manifest: positiveControl: hypothesis must be a non-empty string');
    expect(result.errors).toContain('bad-manifest: realismGate: regime must be a non-empty string');
    expect(result.errors).toContain('bad-manifest: killCriterion must be a non-empty string');
    expect(result.errors).toContain('bad-manifest: datasets must include a positive_control dataset');
    expect(result.errors).toContain('bad-manifest: datasets must include a real_data dataset');
  });

  it('requires uncommitted generated artifacts to live under /tmp', () => {
    const manifest = validManifest();
    manifest.artifacts = [{
      path: 'benchmarks/generated-result.json',
      purpose: 'Generated output accidentally pointed into the repo.',
      committed: false,
    }];

    const result = validateClaimManifest(manifest, 'bad-artifact');

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('bad-artifact: artifacts[0].path for generated artifacts must be under /tmp');
  });

  it('requires committed artifacts to exist in the working tree', () => {
    const manifest = validManifest();
    manifest.artifacts = [{
      path: 'benchmarks/RERANKER-RELIABILITY-FINDINGS.md',
      purpose: 'Missing committed artifact.',
      committed: true,
    }];

    const result = validateClaimManifest(manifest, 'missing-committed-artifact');

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('missing-committed-artifact: artifacts[0].path for committed artifacts must exist');
  });

  it('reports all validation errors when loading a file', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spacefolding-claim-protocol-'));
    const manifestPath = join(tempDir, 'bad.json');
    writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 2, id: '' }));

    try {
      expect(() => loadClaimManifest(manifestPath)).toThrow(`${manifestPath}: schemaVersion must be 1`);
      expect(() => loadClaimManifest(manifestPath)).toThrow(`${manifestPath}: id must be a non-empty string`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('leaves claimCriteria optional while a manifest is still a candidate', () => {
    const manifest = validManifest();
    manifest.status = 'candidate';
    expect(validManifest().claimCriteria).toBeUndefined();

    const result = validateClaimManifest(manifest, 'candidate-manifest');

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('requires a machine-checkable claimCriteria once a manifest passes candidate stage', () => {
    const manifest = validManifest();
    manifest.status = 'pre_registered';

    const result = validateClaimManifest(manifest, 'pre-reg');

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'pre-reg: claimCriteria is required once a claim is pre_registered, running, or done (prose-only kill criteria are not enforceable)'
    );
  });

  it('accepts a pre_registered manifest with a complete claimCriteria block', () => {
    const manifest = validManifest();
    manifest.status = 'pre_registered';
    manifest.claimCriteria = validClaimCriteria();

    const result = validateClaimManifest(manifest, 'pre-reg-with-criteria');

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('rejects a claimCriteria block with an unsupported aggregation rule', () => {
    const manifest = validManifest();
    manifest.status = 'pre_registered';
    manifest.claimCriteria = { ...validClaimCriteria(), perRegimeAggregation: 'best-of' as unknown as string };

    const result = validateClaimManifest(manifest, 'bad-agg');

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'bad-agg: claimCriteria.perRegimeAggregation must be one of: all, majority'
    );
  });

  it('rejects a claimCriteria block with empty improvement metrics', () => {
    const manifest = validManifest();
    manifest.status = 'pre_registered';
    manifest.claimCriteria = { ...validClaimCriteria(), improvementMetrics: [] };

    const result = validateClaimManifest(manifest, 'no-improvement');

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'no-improvement: claimCriteria.improvementMetrics must be a non-empty string array'
    );
  });
});
