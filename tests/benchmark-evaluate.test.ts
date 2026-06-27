import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BM25F_PARAMS,
  applySanitizedBenchmarkRerank,
  benchmarkCrossEncoderMaxWorkers,
  buildBm25Corpus,
  buildEvaluationReport,
  buildProvenance,
  bm25Baseline,
  bm25BodyBaseline,
  computeGrepTokenCost,
  detectCrossEncoderFallback,
  extractGrepRounds,
  grepBaseline,
  grepProseTerms,
  loadBenchmarkDataset,
  mergeStrategyMetadata,
  parseBenchmarkDataset,
  parseArgs,
  recallAtBudget,
  oracleRerankOutput,
  resolveStrategies,
  resolveWorkerCount,
  scoreBm25f,
  walkDir,
  type BenchmarkRankedChunk,
  type BenchmarkTask,
  type EvalResult,
  type Metrics,
  type StrategyMetadata,
  type StrategySummary,
  type TokenCost,
} from '../benchmarks/evaluate.ts';
import { parseStructuralQuery } from '../src/core/query-planner.ts';
import { DeterministicTokenEstimator } from '../src/providers/token-estimator.ts';
import { materializeBenchmarkCorpus } from '../benchmarks/temp-artifacts.ts';

type Chunk = { id: string; text: string; path?: string };

function bmTask(query: string): BenchmarkTask {
  return {
    id: 'bm-task',
    task: query,
    intent: 'debug',
    relevant_files: [],
    relevant_types: [],
    relevant_keywords: [],
    irrelevant_files: [],
  };
}

const baseMetrics: Metrics = {
  recallAt5: 0,
  recallAt10: 0,
  recallAt20: 0,
  precisionAt5: 0,
  precisionAt10: 0,
  precisionAt20: 0,
  ndcgAt10: 0,
  ndcgAt20: 0,
  mrr: 0,
  hitsAt1: 0,
  hitsAt5: 0,
  avgResults: 0,
};

function result(metrics: Partial<Metrics> = {}): EvalResult {
  return {
    taskId: 'task-1',
    task: 'Find token verification',
    intent: 'understand',
    metrics: { ...baseMetrics, ...metrics },
    details: {
      retrievedPaths: ['src/auth.ts', 'src/cache.ts'],
      relevantPaths: ['src/auth.ts', 'src/token.ts'],
      hits: ['src/auth.ts'],
      misses: ['src/token.ts'],
      hitDetails: [{ path: 'src/auth.ts', rank: 1 }],
      retrievedPathCount: 2,
    },
  };
}

function summary(
  strategy: string,
  averages: Partial<Metrics>,
  results: EvalResult[] = [result(averages)]
): StrategySummary {
  return {
    strategy,
    averages: { ...baseMetrics, ...averages },
    results,
  };
}

describe('retrieval benchmark report', () => {
  it('defaults the benchmark corpus to project context instead of src only', () => {
    expect(parseArgs([], '/repo/benchmarks').corpus).toBe('/repo');
    expect(parseArgs([], '/repo/benchmarks').workers).toBe(1);
    expect(parseArgs([], '/repo/benchmarks').maxChunks).toBeNull();
  });

  it('accepts explicit benchmark scale controls', () => {
    expect(parseArgs(['--workers', '10'], '/repo/benchmarks').workers).toBe(10);
    expect(parseArgs(['--max-chunks', '1000000'], '/repo/benchmarks').maxChunks).toBe(1_000_000);
  });

  it('includes environment examples while skipping benchmark and local agent worktree noise', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spacefolding-evaluate-corpus-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    mkdirSync(join(tempDir, 'benchmarks'), { recursive: true });
    mkdirSync(join(tempDir, 'corpora', 'large-repo'), { recursive: true });
    mkdirSync(join(tempDir, 'tests'), { recursive: true });
    mkdirSync(join(tempDir, '.claude', 'worktrees', 'agent', 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'index.ts'), 'export const ok = true;');
    writeFileSync(join(tempDir, '.env.example'), 'DB_PATH=/tmp/db.sqlite');
    writeFileSync(join(tempDir, 'benchmarks', 'ignored.ts'), 'export const ignored = true;');
    writeFileSync(join(tempDir, 'corpora', 'large-repo', 'ignored.ts'), 'export const ignored = true;');
    writeFileSync(join(tempDir, 'tests', 'ignored.test.ts'), 'export const ignored = true;');
    writeFileSync(join(tempDir, '.claude', 'worktrees', 'agent', 'src', 'ignored.ts'), 'export const ignored = true;');

    try {
      const files = walkDir(tempDir, false).map((file) => relative(tempDir, file));

      expect(files).toEqual(['.env.example', 'src/index.ts']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not follow corpus symlinks outside the benchmark tree', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spacefolding-evaluate-corpus-'));
    const external = mkdtempSync(join(tmpdir(), 'spacefolding-evaluate-private-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'index.ts'), 'export const ok = true;');
    writeFileSync(join(external, 'private.ts'), 'export const secret = true;');
    symlinkSync(external, join(tempDir, 'src', 'linked-private'), 'dir');

    try {
      const files = walkDir(tempDir, true).map((file) => relative(tempDir, file));

      expect(files).toEqual(['src/index.ts']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it('rejects malformed CLI arguments before running benchmark work', () => {
    expect(() => parseArgs(['--dataset', '--json'], '/benchmarks')).toThrow(
      '--dataset requires a value'
    );
    expect(() => parseArgs(['--unknown'], '/benchmarks')).toThrow(
      'Unknown argument: --unknown'
    );
    expect(() => parseArgs(['structural'], '/benchmarks')).toThrow(
      'Unknown argument: structural'
    );
    expect(() => parseArgs(['--workers', '0'], '/benchmarks')).toThrow(
      '--workers must be a positive integer'
    );
    expect(() => parseArgs(['--workers', '1.5'], '/benchmarks')).toThrow(
      '--workers must be a positive integer'
    );
    expect(() => parseArgs(['--max-chunks', '0'], '/benchmarks')).toThrow(
      '--max-chunks must be a positive integer'
    );
  });

  it('validates requested benchmark strategies consistently', () => {
    expect(resolveStrategies('all')).toEqual([
      'keyword',
      'bm25',
      'bm25body',
      'path-match',
      'fts',
      'grep',
      'vector',
      'symbol-only',
      'structural',
    ]);
    expect(resolveStrategies('grep')).toEqual(['grep']);
    expect(resolveStrategies('structural')).toEqual(['structural']);
    expect(resolveStrategies('structural-plain')).toEqual(['structural-plain']);
    expect(resolveStrategies('structural-rerank-deterministic')).toEqual(['structural-rerank-deterministic']);
    expect(resolveStrategies('structural-rerank-cross-encoder')).toEqual(['structural-rerank-cross-encoder']);
    expect(resolveStrategies('structural-rerank-oracle')).toEqual(['structural-rerank-oracle']);
    expect(() => resolveStrategies('bogus')).toThrow(
      'Unknown benchmark strategy "bogus"'
    );
  });

  it('promotes oracle-relevant chunks and reduces tokensToFirstHit', () => {
    const ranked: BenchmarkRankedChunk[] = [
      { id: 'a', path: 'src/nope.ts', text: 'nope', tokens: 100 },
      { id: 'b', path: 'src/gold.ts', text: 'gold', tokens: 20 },
      { id: 'c', path: 'src/other.ts', text: 'other', tokens: 30 },
    ];
    const relevant = new Set(['src/gold.ts']);
    const tokensToFirstHit = (chunks: BenchmarkRankedChunk[]) => {
      let total = 0;
      for (const chunk of chunks) {
        total += chunk.tokens;
        if (chunk.path && relevant.has(chunk.path)) return total;
      }
      return null;
    };

    const reranked = applySanitizedBenchmarkRerank(
      ranked,
      oracleRerankOutput(ranked, relevant),
      20
    );

    expect(reranked.map((chunk) => chunk.id)).toEqual(['b', 'a', 'c']);
    expect(tokensToFirstHit(ranked)).toBe(120);
    expect(tokensToFirstHit(reranked)).toBe(20);
  });

  it('sanitizes malformed reranker output without corrupting ordering', () => {
    const ranked: BenchmarkRankedChunk[] = [
      { id: 'a', path: 'a.ts', text: 'a', tokens: 1 },
      { id: 'b', path: 'b.ts', text: 'b', tokens: 1 },
      { id: 'c', path: 'c.ts', text: 'c', tokens: 1 },
      { id: 'd', path: 'd.ts', text: 'd', tokens: 1 },
    ];

    const reranked = applySanitizedBenchmarkRerank(ranked, [
      { index: 2 },
      { index: 2 },
      { index: 99 },
      { index: -1 },
      { index: 1.5 },
      { index: 1 },
    ], 3);

    expect(reranked.map((chunk) => chunk.id)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('rejects malformed benchmark datasets with direct messages', () => {
    expect(() => parseBenchmarkDataset({ notTasks: [] }, '/tmp/bad-dataset.json')).toThrow(
      'Benchmark dataset must contain a tasks array: /tmp/bad-dataset.json'
    );
    expect(() => parseBenchmarkDataset({ tasks: [] }, '/tmp/bad-dataset.json')).toThrow(
      'Benchmark dataset has no tasks: /tmp/bad-dataset.json'
    );
    expect(() =>
      parseBenchmarkDataset({
        tasks: [{
          id: 'T01',
          task: 'Find token verification',
          intent: 'debug',
          relevant_files: 'src/auth.ts',
        }],
      }, '/tmp/bad-dataset.json')
    ).toThrow(
      'Benchmark dataset task 1 field relevant_files must be an array of strings: /tmp/bad-dataset.json'
    );
  });

  it('reports malformed benchmark dataset JSON with the file path', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spacefolding-evaluate-test-'));
    const datasetPath = join(tempDir, 'malformed.json');
    writeFileSync(datasetPath, '{bad json');

    try {
      expect(() => loadBenchmarkDataset(datasetPath)).toThrow(
        `Malformed benchmark dataset JSON at ${datasetPath}`
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports unreadable benchmark dataset JSON with the file path', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spacefolding-evaluate-test-'));
    const datasetPath = join(tempDir, 'missing.json');

    try {
      expect(() => loadBenchmarkDataset(datasetPath)).toThrow(
        `Unable to read benchmark dataset JSON at ${datasetPath}`
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const gateStrategies = (s: {
    keyword: Partial<Metrics>;
    bm25: Partial<Metrics>;
    fts: Partial<Metrics>;
    structural: Partial<Metrics>;
  }) => [
    summary('keyword', s.keyword),
    summary('bm25', s.bm25),
    summary('fts', s.fts),
    summary('structural', s.structural),
  ];

  it('passes the composite gate when structural is non-inferior on recall and beats fts on hits@1', () => {
    const report = buildEvaluationReport({
      dataset: 'benchmarks/dataset.json',
      corpus: 'src',
      requestedStrategies: ['keyword', 'bm25', 'fts', 'structural'],
      strategies: gateStrategies({
        keyword: { recallAt10: 0.70, hitsAt1: 0.30 },
        bm25: { recallAt10: 0.85, hitsAt1: 0.50 },
        fts: { recallAt10: 0.80, hitsAt1: 0.20 },
        structural: { recallAt10: 0.82, hitsAt1: 0.60 },
      }),
    });

    expect(report.successGate.missingStrategySummaries).toEqual([]);
    expect(report.successGate.recallNonInferiorityMargin).toBe(0.05);
    // best lexical arm by recall@10 is bm25 (0.85); structural 0.82 is within 0.05.
    expect(report.successGate.bestLexicalStrategy).toBe('bm25');
    expect(report.successGate.recallAt10NonInferior).toBe(true);
    expect(report.successGate.hitsAt1BeatsFts).toBe(true);
    expect(report.successGate.structuralMeetsGate).toBe(true);
  });

  it('fails the gate when structural recall trails the best lexical arm beyond the margin', () => {
    const report = buildEvaluationReport({
      dataset: 'benchmarks/dataset.json',
      corpus: 'src',
      requestedStrategies: ['keyword', 'bm25', 'fts', 'structural'],
      strategies: gateStrategies({
        keyword: { recallAt10: 0.70, hitsAt1: 0.30 },
        bm25: { recallAt10: 0.85, hitsAt1: 0.50 },
        fts: { recallAt10: 0.80, hitsAt1: 0.20 },
        structural: { recallAt10: 0.74, hitsAt1: 0.60 }, // 0.74 < 0.85 − 0.05
      }),
    });

    expect(report.successGate.recallAt10NonInferior).toBe(false);
    expect(report.successGate.hitsAt1BeatsFts).toBe(true);
    expect(report.successGate.structuralMeetsGate).toBe(false);
  });

  it('fails the gate when structural only ties fts on hits@1', () => {
    const report = buildEvaluationReport({
      dataset: 'benchmarks/dataset.json',
      corpus: 'src',
      requestedStrategies: ['keyword', 'bm25', 'fts', 'structural'],
      strategies: gateStrategies({
        keyword: { recallAt10: 0.70, hitsAt1: 0.30 },
        bm25: { recallAt10: 0.80, hitsAt1: 0.40 },
        fts: { recallAt10: 0.78, hitsAt1: 0.40 },
        structural: { recallAt10: 0.82, hitsAt1: 0.40 }, // ties fts on hits@1
      }),
    });

    expect(report.successGate.recallAt10NonInferior).toBe(true);
    expect(report.successGate.hitsAt1BeatsFts).toBe(false);
    expect(report.successGate.structuralMeetsGate).toBe(false);
  });

  it('leaves the gate uncomputed when a strong baseline summary is missing', () => {
    const report = buildEvaluationReport({
      dataset: 'benchmarks/dataset.json',
      corpus: 'src',
      requestedStrategies: ['keyword', 'structural'],
      strategies: [
        summary('keyword', { recallAt10: 0.70, hitsAt1: 0.30 }),
        summary('structural', { recallAt10: 0.82, hitsAt1: 0.60 }),
      ],
    });

    expect(report.successGate.requiredStrategySummaries).toEqual(['keyword', 'bm25', 'fts', 'structural']);
    expect(report.successGate.missingStrategySummaries).toEqual(['bm25', 'fts']);
    expect(report.successGate).not.toHaveProperty('structuralMeetsGate');
    expect(report.successGate.recallAt10NonInferior).toBeNull();
    expect(report.successGate.hitsAt1BeatsFts).toBeNull();
  });
});

describe('file-level BM25F baseline', () => {
  it('treats the FILE as the document unit — score is invariant to chunk boundaries', async () => {
    // The same three files, once as a single chunk each and once split into
    // several chunks. A correct file-as-document scorer ignores chunking; the
    // old per-chunk-summed scorer would inflate files split into more chunks.
    const single: Chunk[] = [
      { id: 'a', path: 'a.ts', text: 'alpha beta gamma needle' },
      { id: 'b', path: 'b.ts', text: 'beta gamma delta' },
      { id: 'c', path: 'c.ts', text: 'gamma delta epsilon needle needle' },
    ];
    const split: Chunk[] = [
      { id: 'a1', path: 'a.ts', text: 'alpha beta' },
      { id: 'a2', path: 'a.ts', text: 'gamma needle' },
      { id: 'b1', path: 'b.ts', text: 'beta gamma delta' },
      { id: 'c1', path: 'c.ts', text: 'gamma delta' },
      { id: 'c2', path: 'c.ts', text: 'epsilon needle' },
      { id: 'c3', path: 'c.ts', text: 'needle' },
    ];

    const rankSingle = await bm25Baseline(bmTask('needle'), single);
    const rankSplit = await bm25Baseline(bmTask('needle'), split);

    // Non-matching files are dropped; c.ts (needle x2) outranks a.ts (needle x1).
    expect(rankSingle).toEqual(['c.ts', 'a.ts']);
    // And chunk boundaries do not change the ranking — no many-chunk inflation.
    expect(rankSplit).toEqual(rankSingle);
  });

  it('scores the path as a first-class field — bm25body (pathBoost=0) ignores it', async () => {
    const chunks: Chunk[] = [
      { id: 'p', path: 'src/authentication.ts', text: 'handles requests and responses' },
      { id: 'q', path: 'src/other.ts', text: 'unrelated helper utilities live here' },
      { id: 'r', path: 'src/misc.ts', text: 'more unrelated helper utilities' },
    ];

    // "authentication" appears ONLY in a file path, never in any body.
    const withPath = await bm25Baseline(bmTask('authentication'), chunks);
    const bodyOnly = await bm25BodyBaseline(bmTask('authentication'), chunks);

    expect(withPath).toContain('src/authentication.ts');
    expect(bodyOnly).not.toContain('src/authentication.ts');
    expect(bodyOnly).toEqual([]); // term is in no body at all
  });

  it('weights rare query terms over ubiquitous ones via file-frequency IDF', async () => {
    const chunks: Chunk[] = [
      { id: '1', path: 'f1.ts', text: 'common words here' },
      { id: '2', path: 'f2.ts', text: 'common more words' },
      { id: '3', path: 'special.ts', text: 'common and rare token' },
    ];

    // "common" is in every file (low IDF); "rare" is in one (high IDF) and must
    // dominate the ranking even though every file matches "common".
    const ranked = await bm25Baseline(bmTask('common rare'), chunks);
    expect(ranked[0]).toBe('special.ts');
    expect(ranked).toHaveLength(3); // all three contain "common"
  });

  it('exposes a memoizable, query-independent corpus with file-frequency stats', () => {
    const chunks: Chunk[] = [
      { id: 'a1', path: 'a.ts', text: 'needle alpha' },
      { id: 'a2', path: 'a.ts', text: 'beta needle' },
      { id: 'b1', path: 'b.ts', text: 'alpha beta' },
    ];
    const corpus = buildBm25Corpus(chunks);

    // Two files, not three chunks.
    expect(corpus.docs).toHaveLength(2);
    // "needle" occurs in one FILE (twice in a.ts) → file-frequency 1.
    expect(corpus.docFreq.get('needle')).toBe(1);
    // "alpha" occurs in both files → file-frequency 2.
    expect(corpus.docFreq.get('alpha')).toBe(2);

    // Scoring through the prebuilt corpus matches the convenience wrapper.
    const direct = scoreBm25f(bmTask('needle'), corpus, BM25F_PARAMS);
    expect(direct).toEqual(['a.ts']);
  });
});

describe('agentic-grep baseline (Phase 8 head-to-head)', () => {
  it('extracts distinctive prose terms and drops stopwords/short words', () => {
    const terms = grepProseTerms('Find the token verification logic for the user session');
    expect(terms).toContain('token');
    expect(terms).toContain('verification');
    // stopwords ('the', 'for') and len<=3 words ('user' is 4, kept; 'the' dropped) excluded
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('for');
  });

  it('builds the identifier → subtoken → prose round ladder, capped by maxRounds', () => {
    const task: BenchmarkTask = {
      id: 'g1', task: 'Refactor the computeTokenCost helper for retrieval',
      intent: 'feature', relevant_files: [], relevant_types: [], relevant_keywords: [], irrelevant_files: [],
    };
    const full = extractGrepRounds(task, parseStructuralQuery, 3);
    expect(full.length).toBeGreaterThanOrEqual(1);
    expect(full[0].label).toBe('identifier'); // strongest signal first
    // capping to 1 round keeps only the identifier round
    const one = extractGrepRounds(task, parseStructuralQuery, 1);
    expect(one).toHaveLength(1);
    expect(one[0].label).toBe('identifier');
  });

  it('is gold-blind: the round plan is invariant to relevant_files', () => {
    const base = {
      id: 'g2', task: 'Fix the retrieveContext method', intent: 'debug',
      relevant_types: [], relevant_keywords: [], irrelevant_files: [],
    } as BenchmarkTask;
    const withGold: BenchmarkTask = { ...base, relevant_files: ['src/retrieve.ts'] };
    const noGold: BenchmarkTask = { ...base, relevant_files: ['src/other.ts'] };
    // The query plan must depend ONLY on the task text, never on which file is gold.
    expect(extractGrepRounds(withGold, parseStructuralQuery, 3))
      .toEqual(extractGrepRounds(noGold, parseStructuralQuery, 3));
  });

  it('computes tokensToFirstHit under the matched-context model + whole-file secondary', () => {
    const whole = new Map([['a.ts', 1000], ['b.ts', 2000], ['c.ts', 3000]]);
    const ctx = new Map([['a.ts', 60], ['b.ts', 120], ['c.ts', 180]]);
    const ranked = ['a.ts', 'b.ts', 'c.ts'];
    // gold at rank 2 (b.ts): context cumulative = 60+120 = 180; whole-file = 1000+2000 = 3000
    const hit = computeGrepTokenCost(ranked, whole, ctx, new Set(['b.ts']));
    // headline = matched-context model (what an agent skimming rg output reads)
    expect(hit.tokensToFirstHit).toBe(180);
    expect(hit.tokensByRank).toEqual([60, 180, 360]);
    expect(hit.totalTokens).toBe(360);
    expect(hit.chunksReturned).toBe(3);
    // secondary = whole-file model (the chunk-isolation framing, kept for comparison)
    expect(hit.wholeFileTokensToFirstHit).toBe(3000);
    expect(hit.wholeFileTokensByRank).toEqual([1000, 3000, 6000]);
    expect(hit.wholeFileTotalTokens).toBe(6000);
    // no gold surfaced → both models null
    const miss = computeGrepTokenCost(ranked, whole, ctx, new Set(['zzz.ts']));
    expect(miss.tokensToFirstHit).toBeNull();
    expect(miss.wholeFileTokensToFirstHit).toBeNull();
  });

  it('computes recall@budget from the cumulative token curve', () => {
    const tokenCost: TokenCost = {
      chunksReturned: 3, totalTokens: 600, tokensToFirstHit: 300,
      avgChunkTokens: 200, tokensByRank: [100, 300, 600],
    };
    // gold at ranks 1 and 3 (relevantCount=2): at budget 100 only rank1 (≤100); at
    // 600 both; at 350 ranks 1,2 region but only gold ranks 1,3 → rank3(600)>350 miss.
    expect(recallAtBudget(tokenCost, [1, 3], 2, 100)).toBe(0.5);  // only rank1 within
    expect(recallAtBudget(tokenCost, [1, 3], 2, 600)).toBe(1);    // both within
    expect(recallAtBudget(tokenCost, [1, 3], 2, 350)).toBe(0.5);  // rank3(600) over
  });

  it('runs real ripgrep end-to-end: surfaces the gold file, gold-blind + deterministic', async () => {
    const estimator = new DeterministicTokenEstimator();
    const corpus = [
      { path: 'src/gold.ts', content: 'export function computeTokenCost(ranked, relevant) { return 0; }\n' },
      { path: 'src/distractor.ts', content: 'export function unrelatedThing() { return 1; }\n' },
      { path: 'src/other.ts', content: '// misc helpers for the app\n' },
    ];
    const sources = corpus.map((f) => ({ path: f.path, getContent: () => f.content }));
    const dir = await materializeBenchmarkCorpus(sources, (t) => estimator.estimate(t));
    try {
      const base = {
        id: 'g3', task: 'Find the computeTokenCost function', intent: 'feature',
        relevant_types: [], relevant_keywords: [], irrelevant_files: [],
      } as BenchmarkTask;
      const ctx = (relevant_files: string[]) => ({
        corpusDir: dir.path,
        tokensPath: dir.tokensPath,
        parseStructuralQuery,
        rounds: 3,
        budget: 8000,
        relevantSet: new Set(relevant_files),
      });
      // Correct gold → the file is surfaced and tokensToFirstHit is finite.
      const correct = await grepBaseline({ ...base, relevant_files: ['src/gold.ts'] }, ctx(['src/gold.ts']));
      expect(correct.paths).toContain('src/gold.ts');
      expect(correct.tokenCost.tokensToFirstHit).not.toBeNull();
      expect(correct.tokenCost.tokensByRank?.length).toBe(correct.paths.length);

      // GOLD-BLINDNESS: a different (wrong) gold label must not change the ranking.
      const wrongGold = await grepBaseline({ ...base, relevant_files: ['src/distractor.ts'] }, ctx(['src/distractor.ts']));
      expect(wrongGold.paths).toEqual(correct.paths);
      // ...but it DOES change tokensToFirstHit (gold now at a different rank, or null).
      expect(wrongGold.tokenCost.tokensToFirstHit).not.toBe(correct.tokenCost.tokensToFirstHit);

      // DETERMINISM: identical inputs reproduce the ranking exactly.
      const again = await grepBaseline({ ...base, relevant_files: ['src/gold.ts'] }, ctx(['src/gold.ts']));
      expect(again.paths).toEqual(correct.paths);
    } finally {
      dir.cleanup();
    }
  }, 30_000);
});

describe('cross-encoder fallback detection', () => {
  type Item = { index: number; score: number; reason: string };

  it('detects fallback from the sticky provider flag', () => {
    expect(detectCrossEncoderFallback({ modelFailed: true }, [{ index: 0, score: 0.9, reason: 'cross-encoder relevance' }])).toBe(true);
  });

  it('returns false when the model tagged its own relevance reasons with varied scores', () => {
    const output: Item[] = [
      { index: 0, score: 0.9, reason: 'cross-encoder relevance' },
      { index: 1, score: 0.4, reason: 'cross-encoder relevance' },
    ];
    expect(detectCrossEncoderFallback({ modelFailed: false }, output)).toBe(false);
  });

  it('does not treat a single finite cross-encoder score as degenerate', () => {
    expect(detectCrossEncoderFallback(
      { modelFailed: false },
      [{ index: 0, score: 0.9, reason: 'cross-encoder relevance' }]
    )).toBe(false);
  });

  it('detects the deterministic fallback from its non-cross-encoder reason strings', () => {
    const output: Item[] = [
      { index: 0, score: 1, reason: 'direct keyword match' },
      { index: 1, score: 0, reason: 'no keyword overlap' },
    ];
    expect(detectCrossEncoderFallback({ modelFailed: false }, output)).toBe(true);
  });

  it('detects a model that loaded but returned degenerate (all-equal) scores', () => {
    const output: Item[] = [
      { index: 0, score: 0, reason: 'cross-encoder relevance' },
      { index: 1, score: 0, reason: 'cross-encoder relevance' },
    ];
    expect(detectCrossEncoderFallback({ modelFailed: false }, output)).toBe(true);
  });

  it('detects mixed non-finite scores as invalid model evidence', () => {
    const output = [
      { index: 0, score: 0.9, reason: 'cross-encoder relevance' },
      { index: 1, score: Number.NaN, reason: 'cross-encoder relevance' },
      { index: 2, score: 0.4, reason: 'cross-encoder relevance' },
    ];

    expect(detectCrossEncoderFallback({ modelFailed: false }, output)).toBe(true);
  });

  it('requires every output reason to be tagged as cross-encoder evidence', () => {
    const output: Item[] = [
      { index: 0, score: 0.9, reason: 'cross-encoder relevance' },
      { index: 1, score: 0.4, reason: 'partial keyword match' },
    ];

    expect(detectCrossEncoderFallback({ modelFailed: false }, output)).toBe(true);
  });

  it('treats empty model output as a fallback (the model did not run)', () => {
    expect(detectCrossEncoderFallback({ modelFailed: false }, [])).toBe(true);
  });
});

describe('strategy metadata worker merge', () => {
  const base = (fallbackDetected?: boolean): StrategyMetadata => ({
    baseStrategy: 'structural',
    rerankerMode: 'cross-encoder',
    fallbackDetected,
  });

  it('OR-merges fallbackDetected across workers (any fallback wins)', () => {
    expect(mergeStrategyMetadata(base(false), base(true)).fallbackDetected).toBe(true);
    expect(mergeStrategyMetadata(base(true), base(false)).fallbackDetected).toBe(true);
    expect(mergeStrategyMetadata(base(false), base(false)).fallbackDetected).toBe(false);
  });

  it('falls back to the incoming metadata when no existing entry is present', () => {
    const merged = mergeStrategyMetadata(undefined, base(true));
    expect(merged.fallbackDetected).toBe(true);
    expect(merged.rerankerMode).toBe('cross-encoder');
  });
});

describe('run provenance', () => {
  it('captures git commit, runtime, and an ISO timestamp', () => {
    const p = buildProvenance();

    expect(typeof p.gitCommit).toBe('string');
    expect(p.gitCommit.length).toBeGreaterThan(0);
    expect(p.nodeVersion).toBe(process.version);
    expect(p.platform).toBe(process.platform);
    expect(p.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });
});

describe('cross-encoder worker cap', () => {
  it('defaults the cap to 2 and reads BENCH_RERANKER_MAX_WORKERS', () => {
    const before = process.env.BENCH_RERANKER_MAX_WORKERS;
    try {
      delete process.env.BENCH_RERANKER_MAX_WORKERS;
      expect(benchmarkCrossEncoderMaxWorkers()).toBe(2);
      process.env.BENCH_RERANKER_MAX_WORKERS = '3';
      expect(benchmarkCrossEncoderMaxWorkers()).toBe(3);
    } finally {
      if (before === undefined) delete process.env.BENCH_RERANKER_MAX_WORKERS;
      else process.env.BENCH_RERANKER_MAX_WORKERS = before;
    }
  });

  it('caps worker count only for the cross-encoder arm (mitigate concurrent model-load OOM)', () => {
    expect(resolveWorkerCount(8, 100, 'structural', 2)).toBe(8);
    expect(resolveWorkerCount(8, 100, 'structural-rerank-deterministic', 2)).toBe(8);
    expect(resolveWorkerCount(8, 100, 'structural-rerank-cross-encoder', 2)).toBe(2);
    expect(resolveWorkerCount(8, 1, 'structural-rerank-cross-encoder', 2)).toBe(1);
  });
});
