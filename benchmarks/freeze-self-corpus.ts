/**
 * Freeze the deterministic blocking gate's self-corpus into a committed snapshot.
 *
 * The gate scores retrieval against spacefolding's own source. If it walks the
 * LIVE repo tree, the file-level BM25F baseline drifts every time a source file is
 * added/changed (small corpus ~47 files → high IDF sensitivity), so the pinned
 * deterministic-baseline.json goes stale and the gate can flip red on a pure
 * corpus-growth artifact (no retrieval regression). Freezing the corpus to a
 * committed { path, content }[] snapshot decouples the gate from repo growth: the
 * gate measures retrieval LOGIC against a FIXED corpus, and only a deliberate
 * re-freeze (+ baseline re-pin) changes the reference.
 *
 * Run this, then re-pin benchmarks/baselines/deterministic-baseline.json against
 * `--corpus-snapshot benchmarks/fixtures/self-corpus.json`.
 *
 * Usage:
 *   npx tsx benchmarks/freeze-self-corpus.ts
 *   npx tsx benchmarks/freeze-self-corpus.ts --out benchmarks/fixtures/self-corpus.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkDir } from './evaluate.ts';

function main(): void {
  const benchDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(benchDir, '..');

  let out = join(benchDir, 'fixtures', 'self-corpus.json');
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }

  // Same walk the gate used to use on the live tree (skips benchmarks/, corpora/,
  // dist/, node_modules/, tests/ — so the corpus is src/ + scripts + a few roots).
  const files = walkDir(projectRoot, false)
    .map((abs) => ({
      // Repo-relative POSIX path, matching dataset.json's relevant_files.
      path: relative(projectRoot, abs).split('\\').join('/'),
      content: readFileSync(abs, 'utf-8'),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const snapshot = {
    $schema: 'spacefolding frozen self-corpus snapshot',
    description:
      'Frozen snapshot of the blocking-gate self-corpus (benchmarks/dataset.json fixture). ' +
      'The deterministic gate ingests these files verbatim via evaluate.ts --corpus-snapshot ' +
      'so its BM25F/FTS reference does NOT drift as the repo grows. Regenerate with ' +
      'benchmarks/freeze-self-corpus.ts and re-pin deterministic-baseline.json on a deliberate re-freeze.',
    fileCount: files.length,
    files,
  };

  writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n');
  const bytes = files.reduce((s, f) => s + f.content.length, 0);
  console.log(`Froze ${files.length} files (${(bytes / 1024).toFixed(0)} KB) -> ${relative(projectRoot, out)}`);
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}
if (isMainModule()) main();
