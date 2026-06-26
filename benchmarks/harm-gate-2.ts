/**
 * Harm-flip gate v2 — STRONGER, realistic confuser.
 * v1 used an FTS-only .txt confuser against the structural strategy (robust by design) -> 1.3% lift, CI incl 0.
 * v2 uses a CODE confuser that DEFINES the task's identifiers in a wrong file (competes on the structural /
 * symbol arm) AND contains the query text (FTS) — the realistic "relevant-but-wrong" item — across all
 * three shipped retrieval strategies, measuring top-1 flip AND top-3 demotion of gold.
 *
 * Pre-registered GREEN: harm lift (confuser - control) bootstrap CI lower bound > 0 on >=1 strategy
 * at nHit >= 20, with zero delete-leaks. If no strategy clears it, the direction is too weak on this harness.
 * Run: npx tsx benchmarks/harm-gate-2.ts   (deterministic)
 */
import { readFileSync } from 'node:fs';

const CORPUS = 'benchmarks/fixtures/self-corpus.json';
const TASKS = 'benchmarks/dataset-large.json';
const DB = '/tmp/harm-gate2.db';
const DEPTH = 200;
const STRATEGIES = ['structural', 'hybrid', 'vector'] as const;

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

  const corpus: { path: string; content: string }[] = (JSON.parse(readFileSync(CORPUS, 'utf8')) as { files: { path: string; content: string }[] }).files;
  for (const f of corpus) await pipeline.ingest('file', f.content, undefined, f.path, undefined);
  process.stderr.write(`ingested ${corpus.length} corpus files\n`);

  const tasks: { id: string; task: string; relevant_files: string[]; relevant_keywords?: string[] }[] =
    (JSON.parse(readFileSync(TASKS, 'utf8')) as { tasks: any[] }).tasks;

  const retrievePaths = async (q: string, strategy: string): Promise<string[]> => {
    const r = await pipeline.retrieve(q, 200_000, { strategy, mode: 'exhaustive', topK: DEPTH, returnLimit: DEPTH, maxHops: 0 });
    const paths = (r.chunks as any[]).map((c) => c.path).filter(Boolean) as string[];
    return [...new Set(paths)];
  };

  // REALISTIC CODE CONFUSER: a .ts file that DEFINES every identifier-like keyword from the task
  // (so it competes on the structural/symbol arm) and embeds the query text (FTS). Filed under a wrong path.
  const confuserFor = (t: { task: string; relevant_keywords?: string[] }) => {
    const idents = (t.relevant_keywords || []).filter((k) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k)).slice(0, 10);
    const stubs = idents.length
      ? idents.map((k) => `export function ${k}(...args: unknown[]) { /* unrelated impl */ return args; }`).join('\n')
      : `export function relatedSymbol(...args: unknown[]) { return args; }`;
    return `// Related utility module.\n// Notes: ${t.task}\n${stubs}\n`;
  };
  const controlText = `// Unrelated administrative module.\nexport function noopUtility() { return null; }\n// Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n`;

  // seeded bootstrap
  let seed = 987654321;
  const rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const boot = (a: number[], B = 5000): [number, number, number] => {
    const m = mean(a);
    const est: number[] = [];
    for (let b = 0; b < B; b++) {
      let s = 0;
      for (let i = 0; i < a.length; i++) s += a[Math.floor(rng() * a.length)];
      est.push(s / a.length);
    }
    est.sort((x, y) => x - y);
    return [m, est[Math.floor(B * 0.025)], est[Math.floor(B * 0.975)]];
  };

  const summary: any = { nTasks: tasks.length, strategies: {} };
  let anyGreen = false;
  let totalLeaks = 0;

  for (const strategy of STRATEGIES) {
    let nHit = 0;
    let flipsConf = 0;
    let flipsCtrl = 0;
    let demConf = 0;
    let demCtrl = 0;
    let leaks = 0;
    const diffsTop1: number[] = [];
    const diffsTop3: number[] = [];

    for (const t of tasks) {
      const gold = t.relevant_files;
      const base = await retrievePaths(t.task, strategy);
      const baseTop1 = base[0];
      const baseTop3 = new Set(base.slice(0, 3));
      const goldInTop3 = t.relevant_files.some((g) => baseTop3.has(g));
      // top-1 correct baseline
      if (!(baseTop1 && gold.includes(baseTop1))) continue;
      nHit++;

      const cpath = `/__harm_gate2__/confuser_${strategy}_${nHit}.ts`;
      await pipeline.ingest('file', confuserFor(t), undefined, cpath, undefined);
      const afterC = await retrievePaths(t.task, strategy);
      pipeline.deleteChunksForPath(cpath);
      const flipC = !(afterC[0] === baseTop1);
      const demC = goldInTop3 && !t.relevant_files.some((g) => new Set(afterC.slice(0, 3)).has(g));

      const ppath = `/__harm_gate2__/control_${strategy}_${nHit}.ts`;
      await pipeline.ingest('file', controlText, undefined, ppath, undefined);
      const afterP = await retrievePaths(t.task, strategy);
      pipeline.deleteChunksForPath(ppath);
      const flipP = !(afterP[0] === baseTop1);
      const demP = goldInTop3 && !t.relevant_files.some((g) => new Set(afterP.slice(0, 3)).has(g));

      const restored = await retrievePaths(t.task, strategy);
      if (restored[0] !== baseTop1) leaks++;

      if (flipC) flipsConf++;
      if (flipP) flipsCtrl++;
      if (demC) demConf++;
      if (demP) demCtrl++;
      diffsTop1.push((flipC ? 1 : 0) - (flipP ? 1 : 0));
      diffsTop3.push((demC ? 1 : 0) - (demP ? 1 : 0));
    }
    totalLeaks += leaks;
    const [m1, lo1, hi1] = boot(diffsTop1);
    const [m3, lo3, hi3] = boot(diffsTop3);
    const green1 = nHit >= 20 && leaks === 0 && lo1 > 0;
    const green3 = nHit >= 20 && leaks === 0 && lo3 > 0;
    if (green1 || green3) anyGreen = true;
    summary.strategies[strategy] = {
      nHitCorrectBaseline: nHit,
      leaks,
      top1: { flipsConfuser: flipsConf, flipsControl: flipsCtrl, lift: +m1.toFixed(3), ci95: [+lo1.toFixed(3), +hi1.toFixed(3)], significant: green1 },
      top3demote: { demConfuser: demConf, demControl: demCtrl, lift: +m3.toFixed(3), ci95: [+lo3.toFixed(3), +hi3.toFixed(3)], significant: green3 },
    };
  }

  summary.totalLeaks = totalLeaks;
  summary.green = anyGreen;
  summary.criterion = 'GREEN iff any strategy has top-1 OR top-3 harm-lift CI lower bound > 0 (nHit>=20, no leaks)';
  console.log(JSON.stringify(summary, null, 2));
  pipeline.close();
}

main().catch((e) => { console.error('GATE v2 FAILED:', e); process.exit(1); });
