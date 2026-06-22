/**
 * Phase 8 grep head-to-head analyzer.
 *
 * Reads evaluate.ts JSON outputs (original + --symbol-removed ablation pairs) and
 * computes the launch-artifact numbers: mean tokens-to-first-correct-file (matched-
 * context headline for grep, chunk-based for structural; whole-file as grep's
 * secondary column), recall@10 / hits@1, recall@budget, the symbol-removed collapse,
 * and the paired-bootstrap CI for structural − grep on tokens-to-first-correct-file
 * (the crossover test). Pairs original/ablated runs by filename suffix.
 *
 * Usage:
 *   npx tsx benchmarks/analyze-grep-headtohead.ts /tmp/gh2h/typescript-1k.json /tmp/gh2h/typescript-1k-ablated.json ...
 *
 * Filename convention: <label>.json (original) and <label>-ablated.json (ablation).
 * Prints a markdown summary to stdout.
 */
import { readFileSync } from 'node:fs';
import { pairedDiffCI } from './paired-bootstrap.js';
import type { EvaluationReport, EvalResult, TokenCost } from './evaluate.js';

interface Run {
  label: string;
  ablated: boolean;
  seed: string;
  report: EvaluationReport;
}

function loadRun(path: string): Run {
  const raw = readFileSync(path, 'utf-8');
  if (raw.trim().length === 0) throw new Error(`empty (still being written?): ${path}`);
  const report = JSON.parse(raw) as EvaluationReport;
  const base = path.replace(/\.json$/, '').replace(/[^a-zA-Z0-9_.-]+$/, '');
  const ablated = base.endsWith('-ablated');
  let label = ablated ? base.slice(0, -'-ablated'.length) : base;
  // Seed suffix -sNN (multi-seed runs); strip it for the base label + track it.
  const seedMatch = label.match(/-s(\d+)$/);
  const seed = seedMatch ? seedMatch[1] : '42';
  if (seedMatch) label = label.slice(0, -seedMatch[0].length);
  // Use just the final path component for a clean table label.
  const short = label.split('/').pop() ?? label;
  return { label: short, ablated, seed, report };
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Per-task tokensToFirstHit (null excluded) — matched-context for grep, chunk for structural. */
function perTaskTTH(strategy: EvalResult[], field: keyof TokenCost = 'tokensToFirstHit'): number[] {
  return strategy
    .map((r) => r.details.tokenCost?.[field])
    .filter((v): v is number => typeof v === 'number');
}

/** recall@budget for grep: gold files whose cumulative token rank <= budget. */
function recallAtBudgetFor(strategy: EvalResult[], budget: number): number | null {
  const vals = strategy
    .filter((r) => r.details.tokenCost?.tokensByRank)
    .map((r) => {
      const tc = r.details.tokenCost!;
      const hitRanks = r.details.hitDetails.map((h) => h.rank);
      const gold = r.details.relevantPaths.length;
      if (gold === 0) return null;
      const within = hitRanks.filter((rk) => tc.tokensByRank![rk - 1] <= budget).length;
      return within / gold;
    })
    .filter((v): v is number => v !== null);
  return mean(vals);
}

function pairedTTHCI(structural: EvalResult[], grep: EvalResult[]): { mean: number; low: number; high: number; excludesZero: boolean; n: number } | null {
  // Pair by taskId; both must have a non-null tokensToFirstHit.
  const gById = new Map(grep.map((r) => [r.taskId, r]));
  const a: number[] = [];
  const b: number[] = [];
  for (const s of structural) {
    const g = gById.get(s.taskId);
    const st = s.details.tokenCost?.tokensToFirstHit;
    const gt = g?.details.tokenCost?.tokensToFirstHit;
    if (typeof st === 'number' && typeof gt === 'number') { a.push(st); b.push(gt); }
  }
  if (a.length < 2) return null;
  const ci = pairedDiffCI(a, b, 'tokensToFirstHit');
  return { ...ci, n: a.length };
}

// ── main ─────────────────────────────────────────────────────
const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('Usage: npx tsx benchmarks/analyze-grep-headtohead.ts <json...>');
  process.exit(1);
}

const runs = paths.map(loadRun);
// Group by label → seed → {original?, ablated?} (multi-seed aware).
const byLabelSeed = new Map<string, Map<string, { original?: Run; ablated?: Run }>>();
for (const run of runs) {
  let seedMap = byLabelSeed.get(run.label);
  if (!seedMap) { seedMap = new Map(); byLabelSeed.set(run.label, seedMap); }
  let entry = seedMap.get(run.seed);
  if (!entry) { entry = {}; seedMap.set(run.seed, entry); }
  if (run.ablated) entry.ablated = run; else entry.original = run;
}
const rowLabel = (label: string, seed: string) => (seed === '42' ? label : `${label}-s${seed}`);
const perSeed = [...byLabelSeed.entries()].flatMap(([label, seedMap]) =>
  [...seedMap.entries()].map(([seed, e]) => ({ label, seed, ...e })));

/** Pool per-task (structural − grep) tokensToFirstHit across all seeds for a label. */
function pooledTTHCI(label: string): { mean: number; low: number; high: number; excludesZero: boolean; n: number; seeds: number } | null {
  const seedMap = byLabelSeed.get(label);
  if (!seedMap) return null;
  const a: number[] = [];
  const b: number[] = [];
  let seeds = 0;
  for (const [, { original }] of seedMap) {
    if (!original) continue;
    const S = original.report.strategies.find((s) => s.strategy === 'structural');
    const G = original.report.strategies.find((s) => s.strategy === 'grep');
    if (!S || !G) continue;
    const gById = new Map(G.results.map((r) => [r.taskId, r]));
    for (const s of S.results) {
      const st = s.details.tokenCost?.tokensToFirstHit;
      const gt = gById.get(s.taskId)?.details.tokenCost?.tokensToFirstHit;
      if (typeof st === 'number' && typeof gt === 'number') { a.push(st); b.push(gt); }
    }
    seeds++;
  }
  if (a.length < 2) return null;
  const ci = pairedDiffCI(a, b, 'tokensToFirstHit');
  return { ...ci, n: a.length, seeds };
}

const out: string[] = [];
out.push('# grep head-to-head analysis');
out.push('');
out.push('GPU SFR hybrid (structural) vs agentic-grep. **tokens-to-first-correct-file headline = matched-context**');
out.push('(grep: ripgrep matching-lines read; structural: ~2k-token chunks). whole-file is grep\'s secondary');
out.push('column (the chunk-isolation framing). Paired CI = structural − grep (negative ⇒ structural wins).');
out.push('');

out.push('## tokens-to-first-correct-file (mean, null-excluded; per seed)');
out.push('| corpus-scale | structural | grep(ctx) | grep(whole) | fts | bm25 | Δ(s−g) [95% CI] | n |');
out.push('|---|---|---|---|---|---|---|---|');
const crossover: string[] = [];
for (const { label, seed, original } of perSeed) {
  if (!original) continue;
  const S = original.report.strategies.find((s) => s.strategy === 'structural');
  const G = original.report.strategies.find((s) => s.strategy === 'grep');
  const F = original.report.strategies.find((s) => s.strategy === 'fts');
  const B = original.report.strategies.find((s) => s.strategy === 'bm25');
  if (!S || !G) continue;
  const sT = mean(perTaskTTH(S.results));
  const gCtx = mean(perTaskTTH(G.results));
  const gWhole = mean(perTaskTTH(G.results, 'wholeFileTokensToFirstHit'));
  const fT = F ? mean(perTaskTTH(F.results)) : null;
  const bT = B ? mean(perTaskTTH(B.results)) : null;
  const ci = pairedTTHCI(S.results, G.results);
  const fmt = (v: number | null) => (v === null ? '—' : Math.round(v).toLocaleString());
  const ciStr = ci ? `${ci.mean >= 0 ? '+' : ''}${Math.round(ci.mean)} [${Math.round(ci.low)}..${Math.round(ci.high)}]${ci.excludesZero ? ' *' : ''}` : '—';
  out.push(`| ${rowLabel(label, seed)} | ${fmt(sT)} | ${fmt(gCtx)} | ${fmt(gWhole)} | ${fmt(fT)} | ${fmt(bT)} | ${ciStr} | ${ci?.n ?? '—'} |`);
  if (ci?.excludesZero && ci.mean < 0) crossover.push(`${rowLabel(label, seed)}: structural wins (Δ ${Math.round(ci.mean)} [${Math.round(ci.low)}..${Math.round(ci.high)}], n=${ci.n})`);
  else if (ci?.excludesZero && ci.mean > 0) crossover.push(`${rowLabel(label, seed)}: GREP wins tokens-to-first-correct-file (Δ +${Math.round(ci.mean)}, n=${ci.n})`);
}

out.push('');
out.push('## multi-seed pooled (paired CI pooled across all seeds per corpus-scale)');
out.push('| corpus-scale | seeds | Δ(s−g) [95% CI pooled] | n |');
out.push('|---|---|---|---|');
for (const [label, seedMap] of byLabelSeed) {
  if (seedMap.size < 2) continue; // only pool where >1 seed
  const p = pooledTTHCI(label);
  if (!p) continue;
  const ciStr = `${p.mean >= 0 ? '+' : ''}${Math.round(p.mean)} [${Math.round(p.low)}..${Math.round(p.high)}]${p.excludesZero ? ' *' : ''}`;
  out.push(`| ${label} | ${p.seeds} | ${ciStr} | ${p.n} |`);
  if (p.excludesZero && p.mean < 0) crossover.push(`${label} (pooled, ${p.seeds} seeds): structural wins (Δ ${Math.round(p.mean)} [${Math.round(p.low)}..${Math.round(p.high)}], n=${p.n})`);
  else if (p.excludesZero && p.mean > 0) crossover.push(`${label} (pooled): GREP wins (Δ +${Math.round(p.mean)}, n=${p.n})`);
}

out.push('');
out.push('## recall@10 / hits@1 / recall@8k-budget');
out.push('| corpus-scale | structural R@10/h@1 | grep R@10/h@1/R@8k | fts R@10 | bm25 R@10 |');
out.push('|---|---|---|---|---|');
for (const { label, seed, original } of perSeed) {
  if (!original) continue;
  const S = original.report.strategies.find((s) => s.strategy === 'structural');
  const G = original.report.strategies.find((s) => s.strategy === 'grep');
  const F = original.report.strategies.find((s) => s.strategy === 'fts');
  const B = original.report.strategies.find((s) => s.strategy === 'bm25');
  if (!S || !G) continue;
  const gR8 = recallAtBudgetFor(G.results, 8000);
  out.push(`| ${rowLabel(label, seed)} | ${S.averages.recallAt10.toFixed(3)}/${S.averages.hitsAt1.toFixed(3)} | ${G.averages.recallAt10.toFixed(3)}/${G.averages.hitsAt1.toFixed(3)}/${gR8?.toFixed(3) ?? '—'} | ${F?.averages.recallAt10.toFixed(3) ?? '—'} | ${B?.averages.recallAt10.toFixed(3) ?? '—'} |`);
}

out.push('');
out.push('## symbol-removed ablation (the edge must be shown alongside its collapse)');
out.push('| corpus-scale | structural h@1 orig→ablated | grep h@1 orig→ablated |');
out.push('|---|---|---|');
for (const { label, seed, original, ablated } of perSeed) {
  if (!original || !ablated) continue;
  const So = original.report.strategies.find((s) => s.strategy === 'structural');
  const Sa = ablated.report.strategies.find((s) => s.strategy === 'structural');
  const Go = original.report.strategies.find((s) => s.strategy === 'grep');
  const Ga = ablated.report.strategies.find((s) => s.strategy === 'grep');
  if (!So || !Sa || !Go || !Ga) continue;
  out.push(`| ${rowLabel(label, seed)} | ${So.averages.hitsAt1.toFixed(3)}→${Sa.averages.hitsAt1.toFixed(3)} | ${Go.averages.hitsAt1.toFixed(3)}→${Ga.averages.hitsAt1.toFixed(3)} |`);
}

out.push('');
out.push('## crossover (structural significantly beats grep on tokens-to-first-correct-file, CI excludes 0)');
if (crossover.length === 0) out.push('_No scale where structural significantly beats grep yet — may need larger scale / multi-seed._');
else for (const c of crossover) out.push(`- ${c}`);

console.log(out.join('\n'));
