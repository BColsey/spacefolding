/**
 * Paired bootstrap 95% CIs from an evaluate.ts `--json` report.
 *
 * Reports, per strategy, the mean of each metric with a bootstrap CI, and for a
 * set of contrasts (e.g. structural − fts) the PAIRED bootstrap CI of the
 * per-task difference (same resampled task indices applied to both strategies).
 * A contrast whose 95% CI excludes 0 is flagged `*`.
 *
 * Deterministic: the RNG is seeded from the metric + values, so re-running on
 * the same report yields identical CIs.
 *
 * Usage:
 *   npx tsx benchmarks/paired-bootstrap.ts /tmp/sf-eval-django-gpu.json \
 *     --metric recallAt10 --pairs structural-fts,structural-vector,hybrid-fts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Metrics { [k: string]: number }
interface EvalResult { taskId: string; metrics: Metrics }
interface StrategySummary { strategy: string; averages: Metrics; results: EvalResult[] }
interface Report { strategies: StrategySummary[] }

function mulberry32(seedStr: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function bootstrapMeanCI(values: number[], metric: string, nBoot = 10_000, ci = 0.95) {
  const n = values.length;
  const rng = mulberry32(`mean:${metric}:${values.map((v) => v.toFixed(6)).join(',')}`);
  const means: number[] = [];
  for (let b = 0; b < nBoot; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[Math.floor(rng() * n)];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - ci) / 2;
  return { mean: mean(values), low: means[Math.floor(nBoot * alpha)], high: means[Math.ceil(nBoot * (1 - alpha)) - 1] };
}

function pairedDiffCI(a: number[], b: number[], metric: string, nBoot = 10_000, ci = 0.95) {
  if (a.length !== b.length) throw new Error('paired arrays differ in length');
  const n = a.length;
  const diffs = a.map((v, i) => v - b[i]);
  const rng = mulberry32(`paired:${metric}:${diffs.map((v) => v.toFixed(6)).join(',')}`);
  const means: number[] = [];
  for (let k = 0; k < nBoot; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diffs[Math.floor(rng() * n)];
    means.push(s / n);
  }
  means.sort((x, y) => x - y);
  const alpha = (1 - ci) / 2;
  const low = means[Math.floor(nBoot * alpha)];
  const high = means[Math.ceil(nBoot * (1 - alpha)) - 1];
  return { mean: mean(diffs), low, high, excludesZero: (low > 0 && high > 0) || (low < 0 && high < 0) };
}

/**
 * Split a contrast pair `A-B` into [A, B] using the known strategy set.
 *
 * Strategies themselves may contain hyphens (`path-match`, `symbol-only`,
 * `bm25body`), so a naive `split('-')` mis-splits `structural-path-match` into
 * `structural` + `path` (a non-existent strategy) and `structural-symbol-only`
 * into `structural` + `symbol`. We instead try every hyphen position and accept
 * the unique split where BOTH halves are known strategies, erroring clearly on
 * ambiguity or unknown strategies.
 */
export function splitPair(pair: string, knownStrategies: Set<string>): [string, string] {
  const positions: number[] = [];
  for (let i = 0; i < pair.length; i++) if (pair[i] === '-') positions.push(i);
  if (positions.length === 0) {
    throw new Error(
      `contrast '${pair}' has no '-' separator (known strategies: ${[...knownStrategies].join(', ')})`,
    );
  }
  const valid = positions
    .map((pos) => [pair.slice(0, pos), pair.slice(pos + 1)] as [string, string])
    .filter(([a, b]) => knownStrategies.has(a) && knownStrategies.has(b));
  if (valid.length === 1) return valid[0];
  if (valid.length > 1) {
    throw new Error(
      `ambiguous contrast '${pair}': multiple valid splits (${valid.map((v) => v.join(' − ')).join(' / ')}); use an explicit delimiter`,
    );
  }
  throw new Error(
    `contrast '${pair}': no '-' split yields two known strategies (known: ${[...knownStrategies].join(', ')})`,
  );
}

function main() {
  const [path, ...rest] = process.argv.slice(2);
  if (!path) throw new Error('Provide an evaluate.ts --json report path');
  let metric = 'recallAt10';
  let pairs = 'structural-fts,structural-vector,hybrid-fts,hybrid-vector';
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--metric') metric = rest[++i];
    else if (rest[i] === '--pairs') pairs = rest[++i];
  }

  const report = JSON.parse(readFileSync(path, 'utf-8')) as Report;
  const byStrat = new Map(report.strategies.map((s) => [s.strategy, s]));
  const knownStrategies = new Set(byStrat.keys());
  const vals = (strat: string) => {
    const s = byStrat.get(strat);
    if (!s) throw new Error(`strategy ${strat} not in report (have: ${[...byStrat.keys()].join(', ')})`);
    return s.results.map((r) => r.metrics[metric]);
  };

  const f = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(3);
  console.log(`\nReport: ${path}`);
  console.log(`Metric: ${metric}\n`);
  console.log('=== Per-strategy mean [95% CI] ===');
  for (const s of report.strategies) {
    const v = s.results.map((r) => r.metrics[metric]);
    const ci = bootstrapMeanCI(v, metric);
    console.log(`  ${s.strategy.padEnd(12)} ${ci.mean.toFixed(3)}  [${ci.low.toFixed(3)}, ${ci.high.toFixed(3)}]`);
  }

  console.log('\n=== Paired contrasts (A − B) [95% CI], * = excludes 0 ===');
  for (const pair of pairs.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [a, b] = splitPair(pair, knownStrategies);
    const ci = pairedDiffCI(vals(a), vals(b), metric);
    console.log(`  ${(a + ' − ' + b).padEnd(26)} ${f(ci.mean)}  [${f(ci.low)}, ${f(ci.high)}] ${ci.excludesZero ? '*' : ''}`);
  }
  console.log('');
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) main();
