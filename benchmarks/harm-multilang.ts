/**
 * STREAM M — Multi-language generalization of the arm-specific HARM PATTERN (E1).
 *
 * Question: does structural get harmed via the SYMBOL arm and hybrid via the FTS arm on a
 * REAL multi-k-file codebase (as in E1 on the 47-file self-corpus), or does the pattern
 * change once the corpus is large, multi-file, and multi-language-flavored?
 *
 * Approach:
 *   - Pick the real typescript-compiler corpus (corpora/typescript, shallow clone).
 *   - Deterministic subset: all of src/compiler/*.ts (38 real files, ~108k LOC). This is a
 *     genuine multi-k-LOC codebase but stays well under the 500-file ingest cap and finishes
 *     in minutes. Gold files are included by construction.
 *   - Generate localization tasks DETERMINISTICALLY from clear top-level exported symbols:
 *       task = 'where is <symbol> defined', relevant_files = [the file exporting it].
 *     Cap ~100 tasks (deterministic sorted selection; one task per (symbol,file) pair).
 *   - Ingest with the DETERMINISTIC offline provider (no GPU/network).
 *   - Run the E1 confuser taxonomy (structural-only, fts-only, structural+fts, weak-partial)
 *     under structural + hybrid strategies. HP = P(top-1 flips correct->incorrect | inject c)
 *     - P(flip | control), paired bootstrap 95% CI.
 *
 * Scaffolding (pipeline construction, retrieve, confuser text, bootstrap) is copied from
 * benchmarks/harm-meter.ts verbatim — only the corpus + task source differ.
 *
 * Deterministic, offline. Run: npx tsx benchmarks/harm-multilang.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const CORPUS_ROOT = 'corpora/typescript/src/compiler';
const TASK_CAP = 100;
const DB = '/tmp/harm-multilang.db';
const DEPTH = 200;
const STRATEGIES = ['structural', 'hybrid'] as const;
const TYPES = ['structural-only', 'fts-only', 'structural+fts', 'weak-partial'] as const;

// Deterministic, line-scanning extraction of a single clear exported symbol per file.
// We pick the FIRST top-level `export function <ident>` (most localizable phrasing) and
// fall back to `export const <ident>` / `export class <ident>` so every file is usable.
function pickExportedSymbol(content: string): string | null {
  const fn = content.match(/^export function ([a-zA-Z_$][a-zA-Z0-9_$]*)/m);
  if (fn) return fn[1];
  const cls = content.match(/^export class ([a-zA-Z_$][a-zA-Z0-9_$]*)/m);
  if (cls) return cls[1];
  const cnst = content.match(/^export const ([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/m);
  if (cnst) return cnst[1];
  return null;
}

async function main() {
  const { createRepository } = await import('../dist/storage/repository.js');
  const { DeterministicTokenEstimator } = await import('../dist/providers/token-estimator.js');
  const { DeterministicCompressionProvider } = await import('../dist/providers/deterministic-compression.js');
  const { DeterministicEmbeddingProvider } = await import('../dist/providers/deterministic-embedding.js');
  const { SimpleDependencyAnalyzer } = await import('../dist/providers/dependency-analyzer.js');
  const { ContextScorer } = await import('../dist/core/scorer.js');
  const { ContextRouter, DEFAULT_ROUTING_CONFIG } = await import('../dist/core/router.js');
  const { ContextIngester } = await import('../dist/core/ingester.js');
  const { PipelineOrchestrator } = await import('../dist/pipeline/orchestrator.js');

  const storage = createRepository(DB);
  const tok = new DeterministicTokenEstimator();
  const emb = new DeterministicEmbeddingProvider();
  const comp = new DeterministicCompressionProvider();
  const dep = new SimpleDependencyAnalyzer();
  const scorer = new ContextScorer(DEFAULT_ROUTING_CONFIG, emb, tok);
  const router = new ContextRouter(DEFAULT_ROUTING_CONFIG);
  const ing = new ContextIngester(tok);
  const pipeline = new PipelineOrchestrator(storage, scorer, router, comp, dep, ing, emb);

  // ---- Deterministic corpus selection: every .ts file under CORPUS_ROOT, sorted ----
  const allFiles = readdirSync(CORPUS_ROOT)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => statSync(join(CORPUS_ROOT, f)).isFile())
    .sort(); // deterministic
  const corpus: { path: string; content: string }[] = [];
  for (const f of allFiles) {
    const content = readFileSync(join(CORPUS_ROOT, f), 'utf8');
    corpus.push({ path: `ts-compiler/${f}`, content }); // namespaced path
  }
  process.stderr.write(`selected ${corpus.length} real TS-compiler files (${CORPUS_ROOT})\n`);

  // ---- Deterministic task generation from exported symbols ----
  const tasks: { id: string; task: string; relevant_files: string[]; relevant_keywords: string[]; symbol: string }[] = [];
  for (const f of corpus) {
    const sym = pickExportedSymbol(f.content);
    if (!sym) continue;
    tasks.push({
      id: `ML_${tasks.length.toString().padStart(3, '0')}`,
      task: `where is ${sym} defined`,
      relevant_files: [f.path],
      relevant_keywords: [sym, f.path.split('/').pop()!.replace(/\.ts$/, '')],
      symbol: sym,
    });
    if (tasks.length >= TASK_CAP) break;
  }
  process.stderr.write(`generated ${tasks.length} localization tasks (cap ${TASK_CAP})\n`);

  if (corpus.length === 0 || tasks.length === 0) {
    console.error('MULTILANG: no corpus files or tasks — aborting');
    pipeline.close();
    process.exit(2);
  }

  // ---- Ingest with deterministic provider ----
  for (const f of corpus) await pipeline.ingest('file', f.content, undefined, f.path, 'typescript');
  process.stderr.write(`ingested ${corpus.length} corpus files\n`);

  const retrieve = async (q: string, strategy: string): Promise<string[]> => {
    const r = await pipeline.retrieve(q, 200_000, { strategy, mode: 'exhaustive', topK: DEPTH, returnLimit: DEPTH, maxHops: 0 });
    return [...new Set((r.chunks as any[]).map((c) => c.path).filter(Boolean) as string[])];
  };
  const hitTop1 = (paths: string[], gold: string[]) => paths.length > 0 && gold.includes(paths[0]);

  // ---- Confuser taxonomy (copied from harm-meter.ts) ----
  const idents = (t: { relevant_keywords?: string[] }) => (t.relevant_keywords || []).filter((k) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k)).slice(0, 10);
  const stubs = (ids: string[]) => ids.length ? ids.map((k) => `export function ${k}(...a: unknown[]) { return a; }`).join('\n') : `export function relatedSymbol(...a: unknown[]) { return a; }`;

  const confusers: Record<string, (t: { task: string; relevant_keywords?: string[] }, nonGoldPath: string) => string> = {
    'structural-only': (t) => `// module\n${stubs(idents(t))}\n`,
    'fts-only': (t) => { const k = (t.relevant_keywords || []).slice(0, 6); return `// Discussion of ${k.join(', ')}.\n// ${t.task}\nexport function unrelatedTopic() { return null; }\n`; },
    'structural+fts': (t) => `// Related module.\n// ${t.task}\n${stubs(idents(t))}\n`,
    'weak-partial': (t) => { const k = (t.relevant_keywords || []).slice(0, 2); return `// minor note re ${k.join(',')}\nexport function edgeThing() {}\n`; },
  };
  const controlText = `// Unrelated administrative module.\nexport function noopUtility() { return null; }\n// Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n`;

  // ---- per-(strategy,type) flip accounting ----
  const acc: Record<string, Record<string, { n: number; flipC: number; flipCtrl: number; diffs: number[] }>> = {};
  for (const strategy of STRATEGIES) { acc[strategy] = {}; for (const type of TYPES) acc[strategy][type] = { n: 0, flipC: 0, flipCtrl: 0, diffs: [] }; }

  const baseHitRates: Record<string, number> = {};

  for (const strategy of STRATEGIES) {
    let nHit = 0;
    for (const t of tasks) {
      const gold = t.relevant_files;
      const base = await retrieve(t.task, strategy);
      if (!hitTop1(base, gold)) continue;
      nHit++;
      const nonGold = (corpus.find((f) => !gold.includes(f.path)) || { path: 'elsewhere.ts' }).path;

      const cpath = `/__harm_multilang__/control_${strategy}_${nHit}.ts`;
      await pipeline.ingest('file', controlText, undefined, cpath, undefined);
      const afterCtrl = await retrieve(t.task, strategy);
      pipeline.deleteChunksForPath(cpath);
      const flipCtrl = afterCtrl[0] !== base[0] ? 1 : 0;

      for (const type of TYPES) {
        const ppath = `/__harm_multilang__/${type}_${strategy}_${nHit}.ts`;
        await pipeline.ingest('file', confusers[type](t, nonGold), undefined, ppath, undefined);
        const afterC = await retrieve(t.task, strategy);
        pipeline.deleteChunksForPath(ppath);
        const flipC = afterC[0] !== base[0] ? 1 : 0;
        const a = acc[strategy][type];
        a.n++; a.flipC += flipC; a.flipCtrl += flipCtrl; a.diffs.push(flipC - flipCtrl);
      }
    }
    baseHitRates[strategy] = nHit / tasks.length;
    process.stderr.write(`[${strategy}] nHit=${nHit}/${tasks.length} (base top-1 hit rate ${baseHitRates[strategy].toFixed(3)})\n`);
  }

  // ---- seeded bootstrap ----
  let seed = 42424242;
  const rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const bootCI = (vals: number[], B = 4000): [number, number, number] => {
    const m = mean(vals); const e: number[] = [];
    for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < vals.length; i++) s += vals[Math.floor(rng() * vals.length)]; e.push(s / vals.length); }
    e.sort((x, y) => x - y);
    return [m, e[Math.floor(B * 0.025)], e[Math.floor(B * 0.975)]];
  };

  const e1: any = {};
  for (const strategy of STRATEGIES) {
    e1[strategy] = {};
    for (const type of TYPES) {
      const a = acc[strategy][type];
      const [m, lo, hi] = bootCI(a.diffs);
      e1[strategy][type] = { n: a.n, flipsConfuser: a.flipC, flipsControl: a.flipCtrl, HP: +m.toFixed(3), ci95: [+lo.toFixed(3), +hi.toFixed(3)], sig: lo > 0 };
    }
  }

  // E1 pattern check: did structural get harmed via SYMBOL arm (structural-only) and hybrid via FTS arm (fts-only)?
  const structSymbol = e1['structural']['structural-only'];
  const hybridFts = e1['hybrid']['fts-only'];

  console.log(JSON.stringify({
    stream: 'M',
    corpus: 'typescript-compiler (corpora/typescript/src/compiler)',
    corpusFiles: corpus.length,
    tasksGenerated: tasks.length,
    baseTop1HitRate: baseHitRates,
    e1,
    e1PatternCheck: {
      'structural harmed via SYMBOL arm (structural-only)': structSymbol.sig ? `YES HP=${structSymbol.HP} ci=[${structSymbol.ci95}]` : `no HP=${structSymbol.HP} ci=[${structSymbol.ci95}]`,
      'hybrid harmed via FTS arm (fts-only)': hybridFts.sig ? `YES HP=${hybridFts.HP} ci=[${hybridFts.ci95}]` : `no HP=${hybridFts.HP} ci=[${hybridFts.ci95}]`,
    },
    readsAs: 'E1 = which retrieval arm carries harm (structural-symbol vs FTS-prose vs both) on a REAL multi-k-file codebase; compare HP across types within a strategy vs the self-corpus E1 result (structural-only harmed structural ~42.5%; fts-only harmed hybrid ~31.3%).',
  }, null, 2));
  pipeline.close();
}

main().catch((e) => { console.error('HARM-MULTILANG FAILED:', e); process.exit(1); });
