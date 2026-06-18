/**
 * Storage scale benchmark — cold ingest, vec0 reopen, and retrieval latency at
 * increasing corpus sizes. Proves the two Phase-4 hardening properties:
 *   (1) the engine ingests + serves large corpora (the Phase-8 "wins at scale"
 *       precondition), and (2) reopening a populated DB no longer DROPs+rebuilds
 *       the vec0 table (getVectorIndexRebuildCount stays at 1 across reopen).
 *
 * Deterministic embeddings (no GPU) — this measures the storage/index path, not
 * embedding quality.
 *
 * Usage:
 *   npx tsx benchmarks/scale-benchmark.ts --corpus corpora/django --max-files 1000
 *   npx tsx benchmarks/scale-benchmark.ts --corpus corpora/rust            # whole corpus
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { createRepository } from '../src/storage/repository.js';

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.rs', '.go', '.java', '.kt', '.rb', '.php', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.swift', '.scala']);

function walkCodeFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.git' || name === 'target' || name === 'dist' || name === 'vendor') continue;
      walkCodeFiles(full, out);
    } else if (st.isFile() && CODE_EXT.has(name.slice(name.lastIndexOf('.')).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function parseArgs(argv: string[]) {
  const opts: { corpus: string; maxFiles: number | null } = { corpus: '', maxFiles: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--corpus') opts.corpus = argv[++i]!;
    else if (argv[i] === '--max-files') opts.maxFiles = Number(argv[++i]);
  }
  if (!opts.corpus) throw new Error('--corpus required');
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const require = createRequire(import.meta.url);
  const { DeterministicEmbeddingProvider } = require('../dist/providers/deterministic-embedding.js');
  const embedder = new DeterministicEmbeddingProvider();

  const allFiles = walkCodeFiles(opts.corpus);
  const files = (opts.maxFiles && opts.maxFiles > 0 ? allFiles.slice(0, opts.maxFiles) : allFiles);
  const dbPath = `/tmp/sf-scale-${Date.now()}.db`;

  const mem = () => Math.round(process.memoryUsage().rss / 1024 / 1024);

  // Cold ingest
  const coldStart = Date.now();
  const repo = createRepository(dbPath);
  let chunks = 0;
  let dim = 0;
  for (const file of files) {
    let content: string;
    try { content = readFileSync(file, 'utf-8'); } catch { continue; }
    const id = `c${chunks}`;
    const path = relative(opts.corpus, file);
    repo.storeChunk({ id, source: 'scale', type: 'code', text: content, timestamp: Date.now(), path, language: undefined, tokensEstimate: Math.ceil(content.length / 4), parentId: undefined, childrenIds: [], metadata: {} });
    const emb = await embedder.embed(content.slice(0, 2000));
    if (!dim) dim = emb.length;
    repo.storeEmbedding(id, emb, 'deterministic-scale'); // vector index null here -> chunk_embeddings only
    chunks++;
  }
  // Build the vec0 index once, hydrating from chunk_embeddings (cold build).
  if (dim) repo.initVectorIndex(dim);
  const coldMs = Date.now() - coldStart;
  const memAfterIngest = mem();

  // Reopen — this is the P4 payoff: must NOT rebuild vec0 (rebuildCount stays at 1).
  repo.close();
  const reopenStart = Date.now();
  const reopened = createRepository(dbPath);
  reopened.initVectorIndex(dim);
  const reopenMs = Date.now() - reopenStart;
  const rebuildCount = reopened.getVectorIndexRebuildCount();

  // Retrieval latency (vector + structural)
  const probeText = files[0] ? readFileSync(files[0], 'utf-8').slice(0, 2000) : '';
  const probeEmb = await embedder.embed(probeText);
  const vStart = Date.now();
  const vHits = reopened.searchByVector(probeEmb, 20);
  const vMs = Date.now() - vStart;

  reopened.close();
  // cleanup db files
  for (const suffix of ['', '-wal', '-shm']) { try { require('node:fs').unlinkSync(dbPath + suffix); } catch { /* */ } }

  const result = {
    corpus: opts.corpus,
    files: files.length,
    chunks,
    embeddingDim: dim,
    coldIngestMs: coldMs,
    coldIngestSec: +(coldMs / 1000).toFixed(2),
    reopenMs,
    reopenSec: +(reopenMs / 1000).toFixed(3),
    vecRebuildCount: rebuildCount,
    vectorSearch20Ms: vMs,
    vectorSearch20Hits: vHits.length,
    rssMbAfterIngest: memAfterIngest,
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
