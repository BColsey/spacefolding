/**
 * Harm-flip power-analysis GATE for the "per-item causal harm-potential" research direction.
 *
 * Question: is there a measurable per-item HARM effect (a relevant-but-wrong context item
 * flipping a CORRECT localization to incorrect) ABOVE NOISE, at affordable N, on the
 * existing deterministic harness?
 *
 * Protocol (causal injection, deterministic, offline):
 *  - Ingest the frozen self-corpus (47 files) into a temp DB with the deterministic provider.
 *  - For each of the 250 dataset-large localization tasks, run the structural strategy.
 *  - On tasks where gold is currently top-1 (CORRECT baseline), inject a CONFUSER chunk
 *    (a .txt chunk stuffed with the task's own query + keywords -> maximally FTS-relevant,
 *     filed under a wrong path, no code structure) and a CONTROL chunk (no keyword overlap).
 *  - A FLIP = the top-1 file changed after injection. Harm lift = P(flip|confuser) - P(flip|control).
 *  - Paired bootstrap 95% CI over the per-task (confuser - control) flip difference.
 *
 * GREEN if nHit >= 20 AND the CI lower bound > 0 (harm lifts significantly above control/noise).
 * Run:  npx tsx benchmarks/harm-gate.ts   (deterministic; no GPU/network)
 */
import { readFileSync } from 'node:fs';

const CORPUS = 'benchmarks/fixtures/self-corpus.json';
const TASKS = 'benchmarks/dataset-large.json';
const DB = '/tmp/harm-gate.db';
const STRATEGY = 'structural';
const DEPTH = 200;

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

  const retrievePaths = async (q: string): Promise<string[]> => {
    const r = await pipeline.retrieve(q, 200_000, { strategy: STRATEGY, mode: 'exhaustive', topK: DEPTH, returnLimit: DEPTH, maxHops: 0 });
    const paths = (r.chunks as any[]).map((c) => c.path).filter(Boolean) as string[];
    return [...new Set(paths)];
  };
  const hitTop1 = (paths: string[], gold: string[]) => paths.length > 0 && gold.includes(paths[0]);

  // CONFUSER: maximally FTS-relevant, wrong path, no code structure (.txt). Contains the exact
  // query string + the task's keywords -> strongest possible "relevant-but-wrong" candidate.
  const confuserFor = (t: { task: string; relevant_keywords?: string[] }) => {
    const kws = (t.relevant_keywords || []).filter((k) => k.length > 2);
    return `Related notes for: ${t.task}\nKeywords: ${kws.join(', ')}\nThis section discusses ${kws[0] || 'the topic'} and related ${kws.slice(0, 4).join(', ')} concerns in detail. See also ${t.task}`;
  };
  // CONTROL: no query-keyword overlap.
  const controlText = `Unrelated administrative notes.\nLorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`;

  let nHit = 0;
  let flipsConf = 0;
  let flipsCtrl = 0;
  let leakDetections = 0;
  const diffs: number[] = [];

  for (let ti = 0; ti < tasks.length; ti++) {
    const t = tasks[ti];
    const gold = t.relevant_files;
    const base = await retrievePaths(t.task);
    if (!hitTop1(base, gold)) continue; // only test where the baseline is already CORRECT
    nHit++;

    // CONFUSER injection
    const cpath = `/__harm_gate__/confuser_${nHit}.txt`;
    await pipeline.ingest('file', confuserFor(t), undefined, cpath, undefined);
    const afterC = await retrievePaths(t.task);
    pipeline.deleteChunksForPath(cpath);
    const flipC = !(afterC[0] === base[0]);

    // CONTROL injection
    const ppath = `/__harm_gate__/control_${nHit}.txt`;
    await pipeline.ingest('file', controlText, undefined, ppath, undefined);
    const afterP = await retrievePaths(t.task);
    pipeline.deleteChunksForPath(ppath);
    const flipP = !(afterP[0] === base[0]);

    // leak guard: after both deletions, baseline top-1 must be restored (else delete is leaky)
    const restored = await retrievePaths(t.task);
    if (restored[0] !== base[0]) leakDetections++;

    if (flipC) flipsConf++;
    if (flipP) flipsCtrl++;
    diffs.push((flipC ? 1 : 0) - (flipP ? 1 : 0));
  }

  // seeded bootstrap (deterministic)
  let seed = 123456789;
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
  const [m, lo, hi] = boot(diffs);
  const rateConf = nHit ? flipsConf / nHit : 0;
  const rateCtrl = nHit ? flipsCtrl / nHit : 0;

  const result = {
    strategy: STRATEGY,
    nTasks: tasks.length,
    nHitCorrectBaseline: nHit,
    leakDetections, // should be 0; if >0 the delete path is leaky (contamination warning)
    flipsConfuser: flipsConf,
    flipsControl: flipsCtrl,
    rateFlipConfuser: +rateConf.toFixed(3),
    rateFlipControl: +rateCtrl.toFixed(3),
    harmLift: +(rateConf - rateCtrl).toFixed(3),
    harmLiftMean: +m.toFixed(3),
    ci95: [+lo.toFixed(3), +hi.toFixed(3)],
    green: nHit >= 20 && leakDetections === 0 && lo > 0,
    criterion: 'GREEN iff nHit>=20 AND no delete-leak AND bootstrap CI lower bound > 0',
  };
  console.log(JSON.stringify(result, null, 2));
  pipeline.close();
}

main().catch((e) => { console.error('GATE FAILED:', e); process.exit(1); });
