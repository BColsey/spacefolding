/**
 * Pick the honest best WS0.3 fusion config from one or more fusion-sweep.ts
 * outputs, guarding against overfitting:
 *
 *  - Selection objective is computed on the CALIBRATION split only and is the
 *    MINIMUM over repos of margin = structural_R@10 − max(vector_R@10, fts_R@10).
 *    Maximizing the worst-repo margin resists tuning to a single corpus.
 *  - The chosen config is then reported on the HOLDOUT split (never used for
 *    selection) and on the full set, per repo — that is the validation number.
 *
 * Usage:
 *   npx tsx benchmarks/analyze-sweep.ts /tmp/sf-sweep-django.json /tmp/sf-sweep-typescript.json
 */

import { readFileSync } from 'node:fs';

type Split = 'all' | 'calib' | 'holdout';

interface TaskMetrics {
  recallAt5: number; recallAt10: number; recallAt20: number;
  ndcgAt10: number; mrr: number; hitsAt1: number; hitsAt5: number;
}
interface SplitTriple { all: TaskMetrics; calib: TaskMetrics; holdout: TaskMetrics }
interface ConfigResult {
  label: string;
  weights: { structural: number; vector: number; fts: number; dependency: number; graph: number };
  vectorFloor: number;
  all: TaskMetrics; calib: TaskMetrics; holdout: TaskMetrics;
}
interface SweepReport {
  repo: string; nTasks: number; embedding: string;
  baselines: { vector: SplitTriple; fts: SplitTriple; hybridDefault: SplitTriple; structuralDefault: SplitTriple };
  configs: ConfigResult[];
}

function baselineBestR10(rep: SweepReport, split: Split): number {
  return Math.max(rep.baselines.vector[split].recallAt10, rep.baselines.fts[split].recallAt10);
}

function margin(rep: SweepReport, cfg: ConfigResult, split: Split): number {
  return cfg[split].recallAt10 - baselineBestR10(rep, split);
}

function fmt(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(3);
}

function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    throw new Error('Provide one or more fusion-sweep JSON paths');
  }
  const reports: SweepReport[] = paths.map((p) => JSON.parse(readFileSync(p, 'utf-8')) as SweepReport);

  // Per-repo summary of the static reference strategies.
  console.log('\n=== Reference strategies (R@10, full set) ===');
  console.log('repo'.padEnd(14), 'vector', '  fts ', 'hybrid(def)', 'struct(def)', 'best(v,f)');
  for (const r of reports) {
    console.log(
      r.repo.padEnd(14),
      r.baselines.vector.all.recallAt10.toFixed(3),
      r.baselines.fts.all.recallAt10.toFixed(3),
      '   ' + r.baselines.hybridDefault.all.recallAt10.toFixed(3) + '    ',
      ' ' + r.baselines.structuralDefault.all.recallAt10.toFixed(3) + '     ',
      baselineBestR10(r, 'all').toFixed(3)
    );
  }

  // Intersection of config labels across all repos.
  const labelSets = reports.map((r) => new Set(r.configs.map((c) => c.label)));
  const commonLabels = [...labelSets[0]].filter((l) => labelSets.every((s) => s.has(l)));
  const cfgByLabel = reports.map((r) => new Map(r.configs.map((c) => [c.label, c] as const)));

  // Robust selection on CALIBRATION: maximize the worst-repo calib margin.
  const scored = commonLabels.map((label) => {
    const perRepo = reports.map((r, i) => ({ rep: r, cfg: cfgByLabel[i].get(label)! }));
    const calibMargins = perRepo.map(({ rep, cfg }) => margin(rep, cfg, 'calib'));
    const robustCalib = Math.min(...calibMargins);
    const meanCalibR10 = perRepo.reduce((s, { cfg }) => s + cfg.calib.recallAt10, 0) / perRepo.length;
    return { label, perRepo, robustCalib, meanCalibR10 };
  });
  scored.sort((a, b) => b.robustCalib - a.robustCalib || b.meanCalibR10 - a.meanCalibR10);

  console.log('\n=== Top 8 configs by robust (worst-repo) CALIBRATION margin ===');
  console.log('label'.padEnd(26), 'robustCalib', 'meanCalibR10');
  for (const s of scored.slice(0, 8)) {
    console.log(s.label.padEnd(26), fmt(s.robustCalib).padStart(10), '  ' + s.meanCalibR10.toFixed(3));
  }

  const winner = scored[0];
  console.log('\n=== WINNER (robust calib) ===');
  console.log('label :', winner.label);
  console.log('weights:', JSON.stringify(winner.perRepo[0].cfg.weights), 'vectorFloor=', winner.perRepo[0].cfg.vectorFloor);
  console.log('\nrepo'.padEnd(14), 'split  ', 'struct ', 'vector', '  fts ', 'margin(struct−max(v,f))');
  for (const { rep, cfg } of winner.perRepo) {
    for (const split of ['calib', 'holdout', 'all'] as Split[]) {
      console.log(
        rep.repo.padEnd(14),
        split.padEnd(7),
        cfg[split].recallAt10.toFixed(3) + '  ',
        rep.baselines.vector[split].recallAt10.toFixed(3),
        ' ' + rep.baselines.fts[split].recallAt10.toFixed(3),
        '  ' + fmt(margin(rep, cfg, split)) + (split === 'holdout' ? '  <-- validation' : '')
      );
    }
  }

  // Also report each repo's OWN best holdout config (overfit upper bound) for context.
  console.log('\n=== Per-repo best config by that repo\'s HOLDOUT margin (overfit upper bound) ===');
  for (let i = 0; i < reports.length; i++) {
    const r = reports[i];
    const best = [...r.configs].sort((a, b) => margin(r, b, 'holdout') - margin(r, a, 'holdout'))[0];
    console.log(
      r.repo.padEnd(14), best.label.padEnd(26),
      'holdout struct=' + best.holdout.recallAt10.toFixed(3),
      'margin=' + fmt(margin(r, best, 'holdout'))
    );
  }
  console.log('');
}

main();
