/**
 * Cross-config analysis for the chunk-size / AST sweep.
 *
 * Loads a set of evaluate.ts `--json` reports produced at different chunk
 * settings (maxTokens, AST on/off) for ONE language + provider, and reports:
 *   - per-config mean [95% CI] for a focus strategy (default `structural`) on
 *     recall@10 and hits@1, plus a chunk-INVARIANT control arm (`bm25`, which is
 *     file-level so it should barely move across chunk sizes — the reproduction
 *     check that a delta is signal, not noise);
 *   - paired-bootstrap CIs (matched by taskId) of focus@config − focus@baseline
 *     for recall@10 and hits@1 (the chunk-size effect on retrieval quality);
 *   - token-cost-per-task aggregates (tokens-to-first-correct-file, avg chunk
 *     tokens, total retrieved tokens) and the paired token-cost delta vs baseline.
 *
 * Config files are discovered by the naming convention
 *   {lang}-{provider}-{tag}.json     e.g. django-det-2000.json, django-gpu-500-ast.json
 * where {tag} is the chunk setting (`2000`, `800`, `500`, `500-ast`, ...).
 *
 * Usage:
 *   npx tsx benchmarks/analyze-chunk-sweep.ts --dir /tmp/sf-cs --lang django \
 *     --provider det --baseline 2000 [--strategy structural] [--json]
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapMeanCI, pairedDiffCI } from './paired-bootstrap.ts';

interface TokenCost {
  chunksReturned: number;
  totalTokens: number;
  tokensToFirstHit: number | null;
  avgChunkTokens: number;
}
interface EvalResult {
  taskId: string;
  metrics: Record<string, number>;
  details?: { tokenCost?: TokenCost };
}
interface StrategySummary { strategy: string; averages: Record<string, number>; results: EvalResult[] }
interface Report { strategies: StrategySummary[] }

interface Config {
  tag: string;          // 2000, 800, 500, 500-ast
  size: number;         // parsed maxTokens
  ast: boolean;
  path: string;
  report: Report;
}

function parseArgs(argv: string[]) {
  const opts = {
    dir: '/tmp/sf-cs',
    lang: '',
    provider: 'det',
    baseline: '2000',
    strategy: 'structural',
    control: 'bm25',
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') opts.dir = argv[++i];
    else if (a === '--lang') opts.lang = argv[++i];
    else if (a === '--provider') opts.provider = argv[++i];
    else if (a === '--baseline') opts.baseline = argv[++i];
    else if (a === '--strategy') opts.strategy = argv[++i];
    else if (a === '--control') opts.control = argv[++i];
    else if (a === '--json') opts.json = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.lang) throw new Error('--lang is required');
  return opts;
}

function discoverConfigs(dir: string, lang: string, provider: string): Config[] {
  const prefix = `${lang}-${provider}-`;
  const configs: Config[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const tag = name.slice(prefix.length, -'.json'.length);
    const sizeMatch = tag.match(/^(\d+)/);
    if (!sizeMatch) continue;
    let report: Report;
    try {
      report = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as Report;
    } catch {
      continue;
    }
    if (!Array.isArray(report.strategies)) continue;
    configs.push({
      tag,
      size: Number(sizeMatch[1]),
      ast: tag.includes('ast'),
      path: join(dir, name),
      report,
    });
  }
  // Sort: AST flag last, then descending size (2000, 800, 500, then -ast variants)
  return configs.sort((a, b) => (Number(a.ast) - Number(b.ast)) || (b.size - a.size));
}

function strat(report: Report, name: string): StrategySummary | undefined {
  return report.strategies.find((s) => s.strategy === name);
}

function vals(report: Report, name: string, metric: string): { byId: Map<string, number>; arr: number[] } {
  const s = strat(report, name);
  const byId = new Map<string, number>();
  const arr: number[] = [];
  if (s) for (const r of s.results) { byId.set(r.taskId, r.metrics[metric]); arr.push(r.metrics[metric]); }
  return { byId, arr };
}

function tokenCosts(report: Report, name: string): Map<string, TokenCost> {
  const s = strat(report, name);
  const m = new Map<string, TokenCost>();
  if (s) for (const r of s.results) if (r.details?.tokenCost) m.set(r.taskId, r.details.tokenCost);
  return m;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function meanOf(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }

/** Paired arrays of a metric for two configs, matched by taskId (intersection). */
function pairByTaskId(
  a: Map<string, number>,
  b: Map<string, number>,
): { a: number[]; b: number[]; ids: string[] } {
  const ids: string[] = [];
  const av: number[] = [];
  const bv: number[] = [];
  for (const [id, v] of a) {
    const w = b.get(id);
    if (w !== undefined) { ids.push(id); av.push(v); bv.push(w); }
  }
  return { a: av, b: bv, ids };
}

function f3(n: number): string { return (n >= 0 ? '+' : '') + n.toFixed(3); }
function star(ci: { low: number; high: number }): string {
  return (ci.low > 0 && ci.high > 0) || (ci.low < 0 && ci.high < 0) ? ' *' : '';
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const configs = discoverConfigs(opts.dir, opts.lang, opts.provider);
  if (configs.length === 0) {
    throw new Error(`No configs found matching ${opts.lang}-${opts.provider}-*.json in ${opts.dir}`);
  }
  const baseline = configs.find((c) => c.tag === opts.baseline);
  if (!baseline) throw new Error(`Baseline config ${opts.lang}-${opts.provider}-${opts.baseline}.json not found`);

  const out: Record<string, unknown> = { lang: opts.lang, provider: opts.provider, baseline: opts.baseline, configs: [] };
  const rows: any[] = [];

  for (const cfg of configs) {
    const sR10 = vals(cfg.report, opts.strategy, 'recallAt10');
    const sH1 = vals(cfg.report, opts.strategy, 'hitsAt1');
    const cR10 = vals(cfg.report, opts.control, 'recallAt10');
    const cH1 = vals(cfg.report, opts.control, 'hitsAt1');
    const tc = [...tokenCosts(cfg.report, opts.strategy).values()];
    const ttfh = tc.map((t) => t.tokensToFirstHit).filter((v): v is number => v != null);

    const sR10ci = bootstrapMeanCI(sR10.arr, 'recallAt10');
    const sH1ci = bootstrapMeanCI(sH1.arr, 'hitsAt1');

    const row: any = {
      tag: cfg.tag, size: cfg.size, ast: cfg.ast,
      structural_R10: sR10ci.mean, structural_R10_ci: [sR10ci.low, sR10ci.high],
      structural_H1: sH1ci.mean, structural_H1_ci: [sH1ci.low, sH1ci.high],
      control_R10: meanOf(cR10.arr), control_H1: meanOf(cH1.arr),
      avgChunkTokens: meanOf(tc.map((t) => t.avgChunkTokens)),
      chunksReturned: meanOf(tc.map((t) => t.chunksReturned)),
      totalTokens: meanOf(tc.map((t) => t.totalTokens)),
      ttfh_mean: meanOf(ttfh), ttfh_median: median(ttfh), ttfh_n: ttfh.length,
    };

    if (cfg.tag !== baseline.tag) {
      // Paired contrasts vs baseline (matched by taskId)
      const r10 = pairByTaskId(sR10.byId, vals(baseline.report, opts.strategy, 'recallAt10').byId);
      const h1 = pairByTaskId(sH1.byId, vals(baseline.report, opts.strategy, 'hitsAt1').byId);
      const r10ci = pairedDiffCI(r10.a, r10.b, 'recallAt10');
      const h1ci = pairedDiffCI(h1.a, h1.b, 'hitsAt1');
      row.vs_baseline_R10 = { mean: r10ci.mean, low: r10ci.low, high: r10ci.high };
      row.vs_baseline_H1 = { mean: h1ci.mean, low: h1ci.low, high: h1ci.high };

      // Paired token-cost delta (tokens-to-first-hit), over tasks where BOTH hit
      const baseTc = tokenCosts(baseline.report, opts.strategy);
      const aTtfh: number[] = [];
      const bTtfh: number[] = [];
      for (const [id, t] of tokenCosts(cfg.report, opts.strategy)) {
        const bt = baseTc.get(id);
        if (t.tokensToFirstHit != null && bt && bt.tokensToFirstHit != null) {
          aTtfh.push(t.tokensToFirstHit); bTtfh.push(bt.tokensToFirstHit);
        }
      }
      if (aTtfh.length > 0) {
        const tci = pairedDiffCI(aTtfh, bTtfh, 'tokensToFirstHit');
        row.vs_baseline_ttfh = { mean: tci.mean, low: tci.low, high: tci.high, n: aTtfh.length };
      }

      // Control-arm invariance check
      const cr = pairByTaskId(cR10.byId, vals(baseline.report, opts.control, 'recallAt10').byId);
      row.control_R10_delta = meanOf(cr.a) - meanOf(cr.b);
    }

    rows.push(row);
    (out.configs as any[]).push(row);
  }

  if (opts.json) { console.log(JSON.stringify(out, null, 2)); return; }

  console.log(`\n${'═'.repeat(78)}`);
  console.log(`  CHUNK-SIZE SWEEP — ${opts.lang} / ${opts.provider} (baseline=${opts.baseline}, focus=${opts.strategy})`);
  console.log(`${'═'.repeat(78)}`);
  console.log(`\n  ${opts.strategy} mean [95% CI] and chunk-invariant control (${opts.control}):`);
  console.log(`  ${'cfg'.padEnd(10)} ${'R@10'.padEnd(22)} ${'Hits@1'.padEnd(22)} ${opts.control}R@10  ${opts.control}H@1`);
  for (const r of rows) {
    console.log(
      `  ${r.tag.padEnd(10)} ` +
      `${r.structural_R10.toFixed(3)} [${r.structural_R10_ci[0].toFixed(3)},${r.structural_R10_ci[1].toFixed(3)}]  `.padEnd(22) +
      `${r.structural_H1.toFixed(3)} [${r.structural_H1_ci[0].toFixed(3)},${r.structural_H1_ci[1].toFixed(3)}]  `.padEnd(22) +
      `${r.control_R10.toFixed(3)}      ${r.control_H1.toFixed(3)}`,
    );
  }

  console.log(`\n  Paired contrast vs baseline ${opts.baseline} (focus@cfg − focus@${opts.baseline}), * = CI excludes 0:`);
  console.log(`  ${'cfg'.padEnd(10)} ${'ΔR@10 [95% CI]'.padEnd(28)} ${'ΔHits@1 [95% CI]'.padEnd(28)} ctrlΔR@10`);
  for (const r of rows) {
    if (!r.vs_baseline_R10) { console.log(`  ${r.tag.padEnd(10)} (baseline)`); continue; }
    console.log(
      `  ${r.tag.padEnd(10)} ` +
      `${f3(r.vs_baseline_R10.mean)} [${f3(r.vs_baseline_R10.low)},${f3(r.vs_baseline_R10.high)}]${star(r.vs_baseline_R10)}`.padEnd(28) +
      `${f3(r.vs_baseline_H1.mean)} [${f3(r.vs_baseline_H1.low)},${f3(r.vs_baseline_H1.high)}]${star(r.vs_baseline_H1)}`.padEnd(28) +
      `${f3(r.control_R10_delta)}`,
    );
  }

  console.log(`\n  Token cost per task (${opts.strategy}):`);
  console.log(`  ${'cfg'.padEnd(10)} ${'avgChunkTok'.padEnd(12)} ${'chunks'.padEnd(8)} ${'totalTok'.padEnd(10)} ${'TTFH mean'.padEnd(11)} ${'TTFH med'.padEnd(10)} ΔTTFH vs base [95% CI]`);
  for (const r of rows) {
    const dt = r.vs_baseline_ttfh
      ? `${f3(r.vs_baseline_ttfh.mean)} [${f3(r.vs_baseline_ttfh.low)},${f3(r.vs_baseline_ttfh.high)}] (n=${r.vs_baseline_ttfh.n})`
      : '(baseline)';
    console.log(
      `  ${r.tag.padEnd(10)} ${r.avgChunkTokens.toFixed(0).padEnd(12)} ${r.chunksReturned.toFixed(1).padEnd(8)} ` +
      `${r.totalTokens.toFixed(0).padEnd(10)} ${r.ttfh_mean.toFixed(0).padEnd(11)} ${r.ttfh_median.toFixed(0).padEnd(10)} ${dt}`,
    );
  }
  console.log('');
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}
if (isMainModule()) main();
