import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BM25F_PARAMS,
  buildBm25Corpus,
  bm25Baseline,
  bm25BodyBaseline,
  buildEvaluationReport,
  loadBenchmarkDataset,
  parseBenchmarkDataset,
  parseArgs,
  resolveStrategies,
  scoreBm25f,
  walkDir,
  type BenchmarkTask,
  type EvalResult,
  type Metrics,
  type StrategySummary,
} from '../benchmarks/evaluate.ts';

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
      'vector',
      'symbol-only',
      'structural',
    ]);
    expect(resolveStrategies('structural')).toEqual(['structural']);
    expect(() => resolveStrategies('bogus')).toThrow(
      'Unknown benchmark strategy "bogus"'
    );
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

  it('includes per-strategy averages and per-task hit and miss details', () => {
    const report = buildEvaluationReport({
      dataset: 'benchmarks/dataset.json',
      corpus: 'src',
      requestedStrategies: ['keyword', 'structural'],
      strategies: [
        summary('keyword', { recallAt10: 0.4, ndcgAt10: 0.3, mrr: 0.25 }),
        summary('structural', { recallAt10: 0.8, ndcgAt10: 0.7, mrr: 0.5 }),
      ],
    });

    expect(report.strategies).toHaveLength(2);
    expect(report.strategies[1].averages).toMatchObject({
      recallAt10: 0.8,
      ndcgAt10: 0.7,
      mrr: 0.5,
    });
    expect(report.strategies[1].results[0].details).toMatchObject({
      hits: ['src/auth.ts'],
      misses: ['src/token.ts'],
      hitDetails: [{ path: 'src/auth.ts', rank: 1 }],
      retrievedPathCount: 2,
    });
    expect(report.successGate.structuralBeatsKeyword).toBe(true);
    expect(report.successGate.recallAt10Delta).toBeCloseTo(0.4);
    expect(report.successGate.ndcgAt10Delta).toBeCloseTo(0.4);
    expect(report.successGate.mrrDelta).toBeCloseTo(0.25);
    expect(report.successGate.missingStrategySummaries).toEqual([]);
  });

  it('makes missing strategy summaries explicit when the strict comparison cannot run', () => {
    const report = buildEvaluationReport({
      dataset: 'benchmarks/dataset.json',
      corpus: 'src',
      requestedStrategies: ['keyword'],
      strategies: [
        summary('keyword', { recallAt10: 0.4, ndcgAt10: 0.3, mrr: 0.25 }),
      ],
    });

    expect(report.successGate.requiredStrategySummaries).toEqual(['keyword', 'structural']);
    expect(report.successGate.missingStrategySummaries).toEqual(['structural']);
    expect(report.successGate).not.toHaveProperty('structuralBeatsKeyword');
    expect(report.successGate.recallAt10Delta).toBeNull();
    expect(report.successGate.ndcgAt10Delta).toBeNull();
    expect(report.successGate.mrrDelta).toBeNull();
  });

  it('keeps structuralBeatsKeyword false with concrete deltas when structural underperforms', () => {
    const report = buildEvaluationReport({
      dataset: 'benchmarks/dataset.json',
      corpus: 'src',
      requestedStrategies: ['keyword', 'structural'],
      strategies: [
        summary('keyword', { recallAt10: 0.8, ndcgAt10: 0.7, mrr: 0.5 }),
        summary('structural', { recallAt10: 0.6, ndcgAt10: 0.75, mrr: 0.4 }),
      ],
    });

    expect(report.successGate.missingStrategySummaries).toEqual([]);
    expect(report.successGate.structuralBeatsKeyword).toBe(false);
    expect(report.successGate.recallAt10Delta).toBeCloseTo(-0.2);
    expect(report.successGate.ndcgAt10Delta).toBeCloseTo(0.05);
    expect(report.successGate.mrrDelta).toBeCloseTo(-0.1);
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
