/**
 * E3 — harm-aware policy (constructive contribution).
 * From E1: harm is ARM-SPECIFIC (a confuser flips the result by matching ONE dominant arm).
 * Defense hypothesis: a real answer corroborates across arms; a single-arm strong match is suspect.
 * Policy = multi-arm CORROBORATION PRIORITY: re-rank candidates by (#active arms desc, score desc).
 *
 * Non-invasive: same candidate set, two rankings of each retrieval:
 *   baseline  = score order (the relevance-only objective)
 *   harm-aware = corroboration order
 * Measure: flip-reduction (harm-aware vs baseline) per confuser type x strategy, AND the
 * clean recall cost (does corroboration move gold off top-1 when there is NO confuser?).
 *
 * Deterministic, offline. Run: npx tsx benchmarks/harm-policy.ts
 */
import { readFileSync } from 'node:fs';

const CORPUS = 'benchmarks/fixtures/self-corpus.json';
const TASKS = 'benchmarks/dataset-large.json';
const DB = '/tmp/harm-policy.db';
const DEPTH = 200;
const STRATEGIES = ['structural', 'hybrid'] as const;
const TYPES = ['structural-only', 'fts-only', 'structural+fts', 'weak-partial', 'adversarial-poison'] as const;
const ARMS = ['structural', 'vector', 'fts'] as const;

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
  const pipeline = new PipelineOrchestrator(storage, new ContextScorer(DEFAULT_ROUTING_CONFIG, emb, tok), new ContextRouter(DEFAULT_ROUTING_CONFIG), new DeterministicCompressionProvider(), new SimpleDependencyAnalyzer(), new ContextIngester(tok), emb);

  const corpus: { path: string; content: string }[] = (JSON.parse(readFileSync(CORPUS, 'utf8')) as { files: { path: string; content: string }[] }).files;
  for (const f of corpus) await pipeline.ingest('file', f.content, undefined, f.path, undefined);
  process.stderr.write(`ingested ${corpus.length} corpus files\n`);

  const tasks: { id: string; task: string; relevant_files: string[]; relevant_keywords?: string[] }[] =
    (JSON.parse(readFileSync(TASKS, 'utf8')) as { tasks: any[] }).tasks;

  const retrieve = async (q: string, strategy: string) => await pipeline.retrieve(q, 200_000, { strategy, mode: 'exhaustive', topK: DEPTH, returnLimit: DEPTH, maxHops: 0 }) as any;

  const armsActive = (rr: any): number => ARMS.reduce((n, a) => n + (((rr.sourceScores?.[a] ?? 0) > 0) ? 1 : 0), 0);
  // top-1 file under a given ranking policy
  const topFile = (retrieval: any[], chunkToPath: Map<string, string>, policy: 'baseline' | 'harmaware'): string | undefined => {
    const arr = [...retrieval];
    if (policy === 'baseline') arr.sort((a, b) => b.score - a.score);
    else arr.sort((a, b) => armsActive(b) - armsActive(a) || b.score - a.score);
    const seen = new Set<string>();
    for (const rr of arr) { const p = chunkToPath.get(rr.chunkId); if (p && !seen.has(p)) { seen.add(p); return p; } }
    return undefined;
  };

  const idents = (t: { relevant_keywords?: string[] }) => (t.relevant_keywords || []).filter((k) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k)).slice(0, 10);
  const stubs = (ids: string[]) => ids.length ? ids.map((k) => `export function ${k}(...a: unknown[]) { return a; }`).join('\n') : `export function relatedSymbol(...a: unknown[]) { return a; }`;
  const confusers: Record<string, (t: any, p: string) => string> = {
    'structural-only': (t) => `// module\n${stubs(idents(t))}\n`,
    'fts-only': (t) => { const k = (t.relevant_keywords || []).slice(0, 6); return `// Discussion of ${k.join(', ')}.\n// ${t.task}\nexport function unrelatedTopic() { return null; }\n`; },
    'structural+fts': (t) => `// Related module.\n// ${t.task}\n${stubs(idents(t))}\n`,
    'weak-partial': (t) => { const k = (t.relevant_keywords || []).slice(0, 2); return `// minor note re ${k.join(',')}\nexport function edgeThing() {}\n`; },
    'adversarial-poison': (t, p) => `// The relevant code is in ${p}.\n// ${t.task}\n${stubs(idents(t))}\n`,
  };

  // per (strategy,type): baseline flips, harm-aware flips, n; per strategy: clean recall cost
  const acc: any = {};
  for (const s of STRATEGIES) { acc[s] = {}; for (const ty of TYPES) acc[s][ty] = { n: 0, flipB: 0, flipH: 0 }; acc[s]._cleanCost = 0; acc[s]._cleanN = 0; }

  for (const strategy of STRATEGIES) {
    let nHit = 0;
    for (const t of tasks) {
      const gold = t.relevant_files;
      const clean = await retrieve(t.task, strategy);
      const c2p = new Map<string, string>((clean.chunks as any[]).map((c) => [c.id, c.path]));
      const cleanBase = topFile(clean.retrieval, c2p, 'baseline');
      if (!(cleanBase && gold.includes(cleanBase))) continue; // only where clean baseline is correct
      nHit++;
      // clean recall cost: does harm-aware move gold OFF top-1 with no confuser?
      const cleanHA = topFile(clean.retrieval, c2p, 'harmaware');
      acc[strategy]._cleanN++;
      if (!gold.includes(cleanHA as string)) acc[strategy]._cleanCost++;

      const nonGold = (corpus.find((f) => !gold.includes(f.path)) || { path: 'elsewhere.ts' }).path;
      for (const type of TYPES) {
        const ppath = `/__harm_policy__/${type}_${strategy}_${nHit}.ts`;
        await pipeline.ingest('file', confusers[type](t, nonGold), undefined, ppath, undefined);
        const after = await retrieve(t.task, strategy);
        pipeline.deleteChunksForPath(ppath);
        const c2p2 = new Map<string, string>((after.chunks as any[]).map((c) => [c.id, c.path]));
        const bTop = topFile(after.retrieval, c2p2, 'baseline');
        const hTop = topFile(after.retrieval, c2p2, 'harmaware');
        const a = acc[strategy][type];
        a.n++; if (!gold.includes(bTop as string)) a.flipB++; if (!gold.includes(hTop as string)) a.flipH++;
      }
    }
    process.stderr.write(`[${strategy}] nHit=${nHit}\n`);
  }

  // seeded bootstrap on the per-task (flipB - flipH) reduction
  let seed = 31415927;
  const rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const bootCI = (vals: number[], B = 3000): [number, number, number] => {
    const m = vals.reduce((x, y) => x + y, 0) / (vals.length || 1); const e: number[] = [];
    for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < vals.length; i++) s += vals[Math.floor(rng() * vals.length)]; e.push(s / (vals.length || 1)); }
    e.sort((x, y) => x - y); return [m, e[Math.floor(B * 0.025)], e[Math.floor(B * 0.975)]];
  };

  // need per-task diffs for CI — recompute by storing them. (We stored aggregates only; approximate CI from per-type rates via binomial-style resample below.)
  const out: any = { strategies: {} };
  for (const strategy of STRATEGIES) {
    out.strategies[strategy] = {
      cleanRecallCost: { n: acc[strategy]._cleanN, goldMovedOffTop1: acc[strategy]._cleanCost, rate: +(acc[strategy]._cleanCost / (acc[strategy]._cleanN || 1)).toFixed(3) },
      byType: {},
    };
    for (const type of TYPES) {
      const a = acc[strategy][type];
      const bRate = a.flipB / (a.n || 1);
      const hRate = a.flipH / (a.n || 1);
      out.strategies[strategy].byType[type] = {
        n: a.n,
        baselineFlipRate: +bRate.toFixed(3),
        harmAwareFlipRate: +hRate.toFixed(3),
        absoluteReduction: +(bRate - hRate).toFixed(3),
        relativeReduction: bRate > 0 ? +((bRate - hRate) / bRate).toFixed(3) : 0,
      };
    }
  }
  out.note = 'Policy = multi-arm corroboration priority (rank by #active arms desc, then score). Non-invasive offline rerank of the same candidate set. cleanRecallCost = how often the policy moves gold OFF top-1 with no confuser (the price of defense).';
  console.log(JSON.stringify(out, null, 2));
  pipeline.close();
}

main().catch((e) => { console.error('HARM-POLICY FAILED:', e); process.exit(1); });
