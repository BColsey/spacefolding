import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

export interface BenchmarkSqliteArtifact {
  path: string;
  cleanup: () => void;
}

export function benchmarkSqlitePath(label: string): string {
  const safeLabel = label.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  return join(tmpdir(), `spacefolding-${safeLabel}-${process.pid}.db`);
}

export function createBenchmarkSqliteArtifact(label: string): BenchmarkSqliteArtifact {
  const path = benchmarkSqlitePath(label);
  removeSqliteArtifacts(path);

  let cleaned = false;
  const cleanupOnExit = () => {
    if (cleaned) return;
    cleaned = true;
    removeSqliteArtifacts(path);
  };

  process.once('exit', cleanupOnExit);

  return {
    path,
    cleanup: () => {
      process.off('exit', cleanupOnExit);
      cleanupOnExit();
    },
  };
}

export function removeSqliteArtifacts(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      unlinkSync(path);
    } catch {}
  }
}

export interface BenchmarkCorpusFile {
  /** Repo-relative path (e.g. "src/core/scorer.ts") — matches dataset relevant_files. */
  path: string;
  content: string;
}

/**
 * Lazy corpus source: path + a getContent() that reads on demand. Used so a 60k-file
 * corpus is NEVER held entirely in memory (reading all content up front OOMs at scale
 * — kibana's large TS files are tens of GB of strings). Content is fetched one file
 * at a time during ingest and grep materialization.
 */
export interface BenchmarkCorpusSource {
  path: string;
  getContent: () => string;
}

export interface BenchmarkCorpusDir {
  /** Temp directory holding the materialized corpus files, laid out by `path`. */
  path: string;
  /** Sidecar JSON ({ [relPath]: tokenCount }) for the grep arm's token-cost walk. */
  tokensPath: string;
  fileCount: number;
  cleanup: () => void;
}

/**
 * Materialize a corpus to a temp directory so the agentic-grep baseline can run real
 * ripgrep against EXACTLY the files the spacefolding pipeline indexed — byte-identical,
 * whether the corpus came from a frozen snapshot (--corpus-snapshot, verbatim) or the
 * gold-retaining --max-files cap. Without this, grep would search a different file set
 * than the hybrid indexed and the head-to-head would be measuring two different corpora.
 *
 * Accepts LAZY sources (getContent) and reads one file at a time — a 60k-file corpus is
 * never held in memory (that OOMs; see BenchmarkCorpusSource). Also writes a token-count
 * sidecar so the grep arm's tokens-to-first-correct-file uses the SAME estimator + units
 * as the hybrid (apples-to-apples) without re-reading files in every worker.
 *
 * Files are written in bounded concurrent batches. Paths must be repo-relative:
 * absolute paths or `..` segments are rejected.
 */
export async function materializeBenchmarkCorpus(
  files: BenchmarkCorpusSource[],
  estimateTokens: (text: string) => number
): Promise<BenchmarkCorpusDir> {
  const dir = mkdtempSync(join(tmpdir(), 'spacefolding-grep-corpus-'));
  // Sidecar lives OUTSIDE the corpus dir (a sibling file) so ripgrep never searches
  // it — the search target stays byte-identical to the indexed file set.
  const tokensPath = `${dir}.tokens.json`;
  const tokens: Record<string, number> = {};

  const BATCH = 64;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    await Promise.all(batch.map(async (file) => {
      if (isAbsolute(file.path) || file.path.includes('..')) {
        throw new Error(`Refusing to materialize corpus path outside the temp tree: ${file.path}`);
      }
      const content = file.getContent(); // lazy — one file at a time, never the whole corpus
      const abs = join(dir, file.path);
      mkdirSync(dirname(abs), { recursive: true });
      await writeFile(abs, content);
      tokens[file.path] = estimateTokens(content);
    }));
  }

  await writeFile(tokensPath, JSON.stringify(tokens));

  let cleaned = false;
  const cleanupOnExit = () => {
    if (cleaned) return;
    cleaned = true;
    rmSync(dir, { recursive: true, force: true });
    try { unlinkSync(tokensPath); } catch {}
  };
  process.once('exit', cleanupOnExit);

  return {
    path: dir,
    tokensPath,
    fileCount: files.length,
    cleanup: () => {
      process.off('exit', cleanupOnExit);
      cleanupOnExit();
    },
  };
}
