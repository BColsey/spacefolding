/**
 * STREAM R — REALISM VALIDATION (the honesty milestone).
 *
 * The E1 confusers (harm-meter.ts) are semi-synthetic: keyword/symbol-stuffed code
 * stubs engineered to activate a specific retrieval arm. This probe validates the harm
 * phenomenon with REAL code confusers — verbatim files sourced from OTHER projects
 * (corpora/typescript, corpora/vscode, corpora/kibana) — as realistic cross-project
 * contaminants.
 *
 * For each task we source a REAL file from corpora/ (outside the task's gold set), trim
 * to ~2-4KB, inject it under a marker path, and measure HP (top-1 flip) vs control on
 * BOTH structural and hybrid strategies. We then split the real confusers by
 * query-keyword overlap (HIGH vs LOW) and report HP for each bucket — does real harm
 * concentrate in high-overlap real files, like the synthetic pattern?
 *
 * Comparison baseline (synthetic E1, harm-meter.ts):
 *   structural-only confuser: structural HP 0.425, CI [0.36,0.49]
 *   fts-only confuser:        hybrid HP 0.313
 *
 * Deterministic, offline. Run: npx tsx benchmarks/harm-realism.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const CORPUS = 'benchmarks/fixtures/self-corpus.json';
const TASKS = 'benchmarks/dataset-large.json';
const DB = '/tmp/harm-realism.db';
const DEPTH = 200;
const STRATEGIES = ['structural', 'hybrid'] as const;
const MAX_TASKS = 120;          // <= 150 cap
const CONFUSERS_PER_TASK = 2;    // two distinct real files per task -> more overlap spread
const MAX_REAL_FILE_BYTES = 4096; // trim huge files

// corpora roots to draw real cross-project confusers from.
// Corpora live in the MAIN checkout (this is an isolated worktree), so resolve via absolute
// path; fall back to a relative path if running from the main checkout directly.
const MAIN_ROOT = '/home/ben/Documents/Projects/spacefolding';
const resolveCorpus = (rel: string) => {
  const abs = `${MAIN_ROOT}/${rel}`;
  try { if (statSync(abs).isDirectory()) return abs; } catch { /* fall through */ }
  return rel;
};
const CORPORA_ROOTS = [
  resolveCorpus('corpora/typescript'),
  resolveCorpus('corpora/vscode'),
  resolveCorpus('corpora/kibana'),
];

/** Walk a corpora root and collect a deterministic sample of real .ts file paths. */
function collectRealFiles(root: string, limit: number, seedRef: { s: number }): string[] {
  const rng = () => ((seedRef.s = (seedRef.s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const out: string[] = [];
  const stack: string[] = [root];
  const all: string[] = [];
  // bounded walk (these trees are huge; cap iterations)
  let iters = 0;
  while (stack.length && iters < 40000) {
    iters++;
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        // prune noisy dirs
        if (/node_modules|\.git|test|tests|__test|fixtures|vendor/.test(full)) continue;
        stack.push(full);
      } else if (st.isFile() && extname(name) === '.ts' && st.size > 400 && st.size < 60000) {
        all.push(full);
      }
    }
  }
  // deterministic shuffle + take limit
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  for (const f of all) { out.push(f); if (out.length >= limit) break; }
  return out;
}

function trimContent(content: string): string {
  if (content.length <= MAX_REAL_FILE_BYTES) return content;
  // keep a head chunk (imports + first declarations are the most "code-shaped" part)
  return content.slice(0, MAX_REAL_FILE_BYTES) + '\n// [trimmed for length]\n';
}

/** Overlap score: how many task tokens (keywords + content words) appear in the file text. */
function overlapScore(taskText: string, keywords: string[], fileText: string): { kwHits: number; wordHits: number; total: number } {
  const lc = fileText.toLowerCase();
  const kwHits = keywords.filter((k) => k && lc.includes(k.toLowerCase())).length;
  // content words from the task query (length>3, not stopwords)
  const stop = new Set(['the', 'where', 'what', 'find', 'this', 'that', 'with', 'from', 'into', 'how', 'does', 'all', 'are', 'for', 'and']);
  const taskWords = taskText.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 3 && !stop.has(w));
  const wordHits = taskWords.filter((w) => lc.includes(w)).length;
  return { kwHits, wordHits, total: kwHits * 3 + wordHits }; // weight keyword hits more (they are identifiers)
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

  // --- ingest self-corpus (the index under test) ---
  const corpus: { path: string; content: string }[] =
    (JSON.parse(readFileSync(CORPUS, 'utf8')) as { files: { path: string; content: string }[] }).files;
  for (const f of corpus) await pipeline.ingest('file', f.content, undefined, f.path, undefined);
  process.stderr.write(`ingested ${corpus.length} corpus files\n`);

  const tasks: { id: string; task: string; relevant_files: string[]; relevant_keywords?: string[] }[] =
    (JSON.parse(readFileSync(TASKS, 'utf8')) as { tasks: any[] }).tasks;
  const subset = tasks.slice(0, MAX_TASKS);
  process.stderr.write(`using ${subset.length} tasks\n`);

  // --- source real confusers from corpora (deterministic) ---
  const seedRef = { s: 987654321 };
  const realPool: string[] = [];
  for (const root of CORPORA_ROOTS) {
    if (realPool.length > 400) break;
    const got = collectRealFiles(root, 180, seedRef);
    realPool.push(...got);
    process.stderr.write(`  ${root}: collected ${got.length} real .ts files\n`);
  }
  process.stderr.write(`real confuser pool: ${realPool.length} files\n`);
  // pre-load contents (trim once)
  const realContents: { path: string; content: string }[] = realPool.map((p) => {
    let content = '';
    try { content = readFileSync(p, 'utf8'); } catch { content = '// unavailable\n'; }
    return { path: p, content: trimContent(content) };
  });

  const retrieve = async (q: string, strategy: string): Promise<string[]> => {
    const r = await pipeline.retrieve(q, 200_000, {
      strategy, mode: 'exhaustive', topK: DEPTH, returnLimit: DEPTH, maxHops: 0,
    });
    return [...new Set((r.chunks as any[]).map((c) => c.path).filter(Boolean) as string[])];
  };
  const hitTop1 = (paths: string[], gold: string[]) => paths.length > 0 && gold.includes(paths[0]);

  const controlText =
    `// Unrelated administrative module.\nexport function noopUtility() { return null; }\n// Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n`;

  // accounting: overall, and split by overlap bucket (HIGH / LOW). Also track confuser rank
  // so a null HP result is interpretable (are real confusers even contenders?).
  type Acc = { n: number; flipC: number; flipCtrl: number; diffs: number[]; overlapScores: number[]; confRanks: number[]; topKReached: number };
  const newAcc = (): Acc => ({ n: 0, flipC: 0, flipCtrl: 0, diffs: [], overlapScores: [], confRanks: [], topKReached: 0 });
  const acc: Record<string, { overall: Acc; high: Acc; low: Acc }> = {};
  for (const strategy of STRATEGIES) acc[strategy] = { overall: newAcc(), high: newAcc(), low: newAcc() };

  let realFileIdx = 0;
  let totalTrials = 0;

  for (const strategy of STRATEGIES) {
    let nHit = 0;
    for (const t of subset) {
      const gold = t.relevant_files;
      const base = await retrieve(t.task, strategy);
      if (!hitTop1(base, gold)) continue; // only probe where baseline is correct (HP definition)
      nHit++;

      // control (shared across the CONFUSERS_PER_TASK trials for this task)
      const cpath = `/__real_confuser__/control_${strategy}_${nHit}.ts`;
      await pipeline.ingest('file', controlText, undefined, cpath, undefined);
      const afterCtrl = await retrieve(t.task, strategy);
      pipeline.deleteChunksForPath(cpath);
      const flipCtrl = afterCtrl[0] !== base[0] ? 1 : 0;

      // pick CONFUSERS_PER_TASK distinct real files (round-robin through the pool)
      for (let c = 0; c < CONFUSERS_PER_TASK; c++) {
        const rf = realContents[realFileIdx % realContents.length];
        realFileIdx++;
        const ov = overlapScore(t.task, t.relevant_keywords || [], rf.content);

        const ppath = `/__real_confuser__/real_${strategy}_${nHit}_${c}.ts`;
        await pipeline.ingest('file', rf.content, undefined, ppath, undefined);
        const afterC = await retrieve(t.task, strategy);
        const confRank = afterC.indexOf(ppath); // -1 if not in top-K
        pipeline.deleteChunksForPath(ppath);
        const flipC = afterC[0] !== base[0] ? 1 : 0;

        const diff = flipC - flipCtrl;
        const bucket = ov.total >= 2 ? 'high' : 'low'; // HIGH = >=2 weighted overlap (a kw hit, or 2+ word hits)
        const a = acc[strategy];
        for (const accKey of ['overall', bucket] as const) {
          const aa = accKey === 'overall' ? a.overall : a[bucket as 'high' | 'low'];
          aa.n++; aa.flipC += flipC; aa.flipCtrl += flipCtrl; aa.diffs.push(diff); aa.overlapScores.push(ov.total);
          if (confRank >= 0) { aa.confRanks.push(confRank + 1); aa.topKReached++; }
        }
        totalTrials++;
      }
    }
    process.stderr.write(`[${strategy}] nHit(tasks with correct baseline)=${nHit}\n`);
  }
  process.stderr.write(`total real-confuser trials: ${totalTrials}\n`);

  // --- seeded bootstrap ---
  let seed = 42424242;
  const rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const bootCI = (vals: number[], B = 4000): [number, number, number] => {
    const m = mean(vals); const e: number[] = [];
    for (let b = 0; b < B; b++) {
      let s = 0; for (let i = 0; i < vals.length; i++) s += vals[Math.floor(rng() * vals.length)];
      e.push(s / vals.length);
    }
    e.sort((x, y) => x - y);
    return [m, e[Math.floor(B * 0.025)], e[Math.floor(B * 0.975)]];
  };
  const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  const summarize = (a: Acc) => {
    const [m, lo, hi] = bootCI(a.diffs);
    const rankInTopK = a.confRanks.length;
    return {
      n: a.n,
      flipsConfuser: a.flipC,
      flipsControl: a.flipCtrl,
      HP: +m.toFixed(3),
      ci95: [+lo.toFixed(3), +hi.toFixed(3)],
      sig: lo > 0,
      overlapMedian: +median(a.overlapScores).toFixed(2),
      overlapMean: +(mean(a.overlapScores)).toFixed(2),
      confuserReachedTopK: `${rankInTopK}/${a.n}`,
      confuserMedianRank: rankInTopK ? +median(a.confRanks).toFixed(1) : null,
    };
  };

  const result: any = {};
  for (const strategy of STRATEGIES) {
    const a = acc[strategy];
    result[strategy] = {
      overall: summarize(a.overall),
      highOverlap: summarize(a.high),
      lowOverlap: summarize(a.low),
    };
  }

  // synthetic E1 numbers for comparison context
  result._syntheticE1baseline = {
    structuralSymbolConfuser: { structural_HP: 0.425, ci: [0.36, 0.49] },
    ftsConfuser: { hybrid_HP: 0.313 },
  };
  result.readsAs =
    'REAL HP = per-item harm from REAL cross-project code files. ' +
    'Compare overall HP to synthetic E1; highOverlap vs lowOverlap shows whether real harm concentrates in files that lexically overlap the query (the synthetic pattern). ' +
    'If overall HP is significant -> ecological validity CONFIRMED; if ~0 -> the phenomenon may be a synthetic artifact.';

  console.log(JSON.stringify(result, null, 2));
  pipeline.close();
}

main().catch((e) => { console.error('HARM-REALISM FAILED:', e); process.exit(1); });
