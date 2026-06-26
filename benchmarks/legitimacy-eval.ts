/**
 * Graph-legitimacy as a REAL code-search quality feature.
 * The harm-potential work's one non-circular salvageable finding: exported symbols with ZERO
 * inbound code-references (isolated) are suspect. L validated it only against SYNTHETIC confusers.
 * This tests whether demoting zero-legitimacy candidates improves REAL retrieval Hits@1 (no confusers).
 *
 * Policies (non-invasive offline rerank of result.retrieval):
 *   baseline      = score order
 *   hard-demote-0 = rank (legit>0) desc, then score desc   [the L hand-designed rule]
 *   soft-lambda   = score + lambda*log1p(legit)            [sweep lambda]
 * Measure Hits@1 per policy vs baseline; paired bootstrap 95% CI on the per-task difference.
 * Deterministic, offline. Run: npx tsx benchmarks/legitimacy-eval.ts
 */
import { readFileSync } from 'node:fs';

const CORPUS = 'benchmarks/fixtures/self-corpus.json';
const TASKS = 'benchmarks/dataset-large.json';
const DB = '/tmp/legitimacy-eval.db';
const DEPTH = 200;
const STRATEGIES = ['structural', 'hybrid'] as const;
const LAMBDAS = [0.001, 0.005, 0.01, 0.05];

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

  // ---- graph legitimacy (copied from harm-learned.ts) ----
  const allSyms = (storage as any).getAllCodeSymbols();
  const allRefs = (storage as any).getAllCodeReferences();
  const exportedByChunk = new Map<string, Set<string>>();
  for (const s of allSyms) if (s.isExported) {
    let set = exportedByChunk.get(s.chunkId); if (!set) { set = new Set(); exportedByChunk.set(s.chunkId, set); }
    set.add(s.normalizedName);
  }
  const incomingByTarget = new Map<string, Set<string>>();
  for (const ref of allRefs) {
    let set = incomingByTarget.get(ref.normalizedTarget); if (!set) { set = new Set(); incomingByTarget.set(ref.normalizedTarget, set); }
    set.add(ref.chunkId);
  }
  const legit = (chunkId: string): number => {
    const exp = exportedByChunk.get(chunkId); if (!exp || exp.size === 0) return 0;
    let total = 0;
    for (const sym of exp) { const refs = incomingByTarget.get(sym); if (!refs) continue; let n = 0; for (const r of refs) if (r !== chunkId) n++; total += n; }
    return total;
  };

  const tasks: { id: string; task: string; relevant_files: string[] }[] = (JSON.parse(readFileSync(TASKS, 'utf8')) as { tasks: any[] }).tasks;
  const retrieve = async (q: string, strategy: string) => {
    const r = await pipeline.retrieve(q, 200_000, { strategy, mode: 'exhaustive', topK: DEPTH, returnLimit: DEPTH, maxHops: 0 }) as any;
    return { retrieval: r.retrieval as any[], c2p: new Map<string, string>((r.chunks as any[]).map((c) => [c.id, c.path])) };
  };
  const topFile = (retrieval: any[], c2p: Map<string, string>, policy: string, lambda = 0): string | undefined => {
    const arr = retrieval.map((rr) => ({ chunkId: rr.chunkId, score: rr.score, leg: legit(rr.chunkId) }));
    if (policy === 'baseline') arr.sort((a, b) => b.score - a.score);
    else if (policy === 'hard-demote-0') arr.sort((a, b) => (b.leg > 0 ? 1 : 0) - (a.leg > 0 ? 1 : 0) || b.score - a.score);
    else if (policy === 'soft') arr.sort((a, b) => (b.score + lambda * Math.log1p(b.leg)) - (a.score + lambda * Math.log1p(a.leg)));
    const seen = new Set<string>();
    for (const x of arr) { const p = c2p.get(x.chunkId); if (p && !seen.has(p)) { seen.add(p); return p; } }
    return undefined;
  };

  // seeded bootstrap on per-task (policyCorrect - baselineCorrect) diffs
  let seed = 27182818;
  const rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const bootCI = (diffs: number[], B = 3000): [number, number, number] => {
    const m = diffs.reduce((x, y) => x + y, 0) / (diffs.length || 1); const e: number[] = [];
    for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(rng() * diffs.length)]; e.push(s / (diffs.length || 1)); }
    e.sort((x, y) => x - y); return [m, e[Math.floor(B * 0.025)], e[Math.floor(B * 0.975)]];
  };

  const out: any = {};
  for (const strategy of STRATEGIES) {
    let base = 0, hard = 0; const n = tasks.length;
    const diffsHard: number[] = [];
    const softHits: Record<number, number> = {}; const softDiffs: Record<number, number[]> = {};
    for (const lam of LAMBDAS) { softHits[lam] = 0; softDiffs[lam] = []; }
    for (const t of tasks) {
      const { retrieval, c2p } = await retrieve(t.task, strategy);
      const gold = t.relevant_files;
      const bOk = !!topFile(retrieval, c2p, 'baseline') && gold.includes(topFile(retrieval, c2p, 'baseline') as string);
      const hTop = topFile(retrieval, c2p, 'hard-demote-0'); const hOk = !!hTop && gold.includes(hTop as string);
      if (bOk) base++; if (hOk) hard++; diffsHard.push((hOk ? 1 : 0) - (bOk ? 1 : 0));
      for (const lam of LAMBDAS) { const sTop = topFile(retrieval, c2p, 'soft', lam); const sOk = !!sTop && gold.includes(sTop as string); if (sOk) softHits[lam]++; softDiffs[lam].push((sOk ? 1 : 0) - (bOk ? 1 : 0)); }
    }
    const [mh, loh, hih] = bootCI(diffsHard);
    const soft: any[] = [];
    for (const lam of LAMBDAS) { const [m, lo, hi] = bootCI(softDiffs[lam]); soft.push({ lambda: lam, hits1: +((softHits[lam] / n).toFixed(3)), deltaHits1: +m.toFixed(3), ci95: [+lo.toFixed(3), +hi.toFixed(3)], sig: lo > 0 }); }
    // pick best soft lambda by CI-lower
    const bestSoft = soft.reduce((a, b) => (b.ci95[0] > a.ci95[0] ? b : a));
    out[strategy] = {
      n, baselineHits1: +(base / n).toFixed(3),
      hardDemoteZero: { hits1: +(hard / n).toFixed(3), deltaHits1: +mh.toFixed(3), ci95: [+loh.toFixed(3), +hih.toFixed(3)], sig: loh > 0 },
      bestSoft,
      interpretation: 'deltaHits1 > 0 with CI excluding 0 => legitimacy IMPROVES real Hits@1; <0 => it hurts; ~0 => no effect (isolated-symbol demotion is not a quality signal on this corpus).',
    };
  }
  console.log(JSON.stringify(out, null, 2));
  pipeline.close();
}

main().catch((e) => { console.error('LEGITIMACY-EVAL FAILED:', e); process.exit(1); });
