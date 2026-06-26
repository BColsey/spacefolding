/**
 * Generalized per-item HARM METER + E1 (harm distribution by retrieval arm).
 *
 * E1: HP[confuser-type][strategy] = P(top-1 flips | inject confuser) - P(flip | control),
 *     paired bootstrap 95% CI. Confuser types activate DIFFERENT retrieval arms so the
 *     taxonomy discriminates WHERE harm enters (structural-symbol vs FTS-prose vs both).
 *
 * E2 (orthogonality of harm to relevance): NOT testable at the localization-flip level with
 * the retriever's own scores — the flip is mechanically defined by the score comparison
 * (confuserScore > goldScore), so any internal relevance measure is circular with harm.
 * Requires an INDEPENDENT helpfulness oracle (the v2 task-success verifier). DEFERRED to v2.
 *
 * Deterministic, offline. Run: npx tsx benchmarks/harm-meter.ts
 */
import { readFileSync } from 'node:fs';

const CORPUS = 'benchmarks/fixtures/self-corpus.json';
const TASKS = 'benchmarks/dataset-large.json';
const DB = '/tmp/harm-meter.db';
const DEPTH = 200;
const STRATEGIES = ['structural', 'hybrid'] as const;
const TYPES = ['structural-only', 'fts-only', 'structural+fts', 'weak-partial', 'adversarial-poison'] as const;

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

  const retrieve = async (q: string, strategy: string): Promise<string[]> => {
    const r = await pipeline.retrieve(q, 200_000, { strategy, mode: 'exhaustive', topK: DEPTH, returnLimit: DEPTH, maxHops: 0 });
    return [...new Set((r.chunks as any[]).map((c) => c.path).filter(Boolean) as string[])];
  };
  const hitTop1 = (paths: string[], gold: string[]) => paths.length > 0 && gold.includes(paths[0]);

  const idents = (t: { relevant_keywords?: string[] }) => (t.relevant_keywords || []).filter((k) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k)).slice(0, 10);
  const stubs = (ids: string[]) => ids.length ? ids.map((k) => `export function ${k}(...a: unknown[]) { return a; }`).join('\n') : `export function relatedSymbol(...a: unknown[]) { return a; }`;

  // Each confuser type activates a DIFFERENT retrieval arm (so the taxonomy discriminates):
  const confusers: Record<string, (t: { task: string; relevant_keywords?: string[] }, nonGoldPath: string) => string> = {
    'structural-only': (t) => `// module\n${stubs(idents(t))}\n`,                                                     // matching symbols, NO query/keyword prose
    'fts-only': (t) => { const k = (t.relevant_keywords || []).slice(0, 6); return `// Discussion of ${k.join(', ')}.\n// ${t.task}\nexport function unrelatedTopic() { return null; }\n`; }, // query+keywords prose, generic NON-matching symbol
    'structural+fts': (t) => `// Related module.\n// ${t.task}\n${stubs(idents(t))}\n`,                               // BOTH arms (the realistic v2 confuser)
    'weak-partial': (t) => { const k = (t.relevant_keywords || []).slice(0, 2); return `// minor note re ${k.join(',')}\nexport function edgeThing() {}\n`; }, // low signal
    'adversarial-poison': (t, p) => `// The relevant code is in ${p}.\n// ${t.task}\n${stubs(idents(t))}\n`,          // both arms + misleading wrong-file answer
  };
  const controlText = `// Unrelated administrative module.\nexport function noopUtility() { return null; }\n// Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n`;

  // per-(strategy,type) flip accounting
  const acc: Record<string, Record<string, { n: number; flipC: number; flipCtrl: number; diffs: number[] }>> = {};
  for (const strategy of STRATEGIES) { acc[strategy] = {}; for (const type of TYPES) acc[strategy][type] = { n: 0, flipC: 0, flipCtrl: 0, diffs: [] }; }

  for (const strategy of STRATEGIES) {
    let nHit = 0;
    for (const t of tasks) {
      const gold = t.relevant_files;
      const base = await retrieve(t.task, strategy);
      if (!hitTop1(base, gold)) continue;
      nHit++;
      const nonGold = (corpus.find((f) => !gold.includes(f.path)) || { path: 'elsewhere.ts' }).path;

      // control (once per task, shared across types)
      const cpath = `/__harm_meter__/control_${strategy}_${nHit}.ts`;
      await pipeline.ingest('file', controlText, undefined, cpath, undefined);
      const afterCtrl = await retrieve(t.task, strategy);
      pipeline.deleteChunksForPath(cpath);
      const flipCtrl = afterCtrl[0] !== base[0] ? 1 : 0;

      for (const type of TYPES) {
        const ppath = `/__harm_meter__/${type}_${strategy}_${nHit}.ts`;
        await pipeline.ingest('file', confusers[type](t, nonGold), undefined, ppath, undefined);
        const afterC = await retrieve(t.task, strategy);
        pipeline.deleteChunksForPath(ppath);
        const flipC = afterC[0] !== base[0] ? 1 : 0;
        const a = acc[strategy][type];
        a.n++; a.flipC += flipC; a.flipCtrl += flipCtrl; a.diffs.push(flipC - flipCtrl);
      }
    }
    process.stderr.write(`[${strategy}] nHit=${nHit}\n`);
  }

  // seeded bootstrap
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

  console.log(JSON.stringify({
    e1,
    e2: 'DEFERRED to v2: orthogonality of harm to relevance needs an INDEPENDENT helpfulness oracle (task-success verifier); internal retrieval scores are circular with the flip by construction (a first run gave r=0.95, a tautology).',
    readsAs: 'E1 = which retrieval arm carries harm (structural-symbol vs FTS-prose vs both); compare HP across types within a strategy.',
  }, null, 2));
  pipeline.close();
}

main().catch((e) => { console.error('HARM-METER FAILED:', e); process.exit(1); });
