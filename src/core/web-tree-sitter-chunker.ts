import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { TokenEstimator } from '../types/index.js';
import { buildChunksFromSymbolRanges, type SymbolRange } from './tree-sitter-chunker.js';

/**
 * Pure-JS AST chunking via web-tree-sitter (WASM), with NO Python sidecar and NO
 * subprocess at chunk time. Boundaries come from the parse tree's top-level named
 * children; the shared boundary→chunk machinery in tree-sitter-chunker.ts turns
 * them into chunks. Grammars are prebuilt `.wasm` files (tree-sitter-wasms),
 * loaded from disk — so this works fully offline once vendored.
 *
 * Everything is lazily, dynamically imported and guarded: if web-tree-sitter or a
 * grammar is unavailable, every entry point returns null and the caller falls
 * back to the regex code splitter. This keeps offline CI green when the optional
 * WASM deps are absent.
 *
 * Gated behind CHUNK_TREE_SITTER=js (see chunker.ts). The Python-sidecar path
 * (CHUNK_TREE_SITTER=1) is unchanged.
 */

const require = createRequire(import.meta.url);

// Our language identifiers → tree-sitter-wasms grammar basenames.
const GRAMMAR_BY_LANGUAGE: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'javascript',
  python: 'python',
  rust: 'rust',
  go: 'go',
  java: 'java',
};

// Node types to skip as top-level boundaries (comments / stray tokens carry no
// structure; they get folded into adjacent pieces by the packer anyway).
const SKIP_NODE_TYPES = new Set(['comment', 'line_comment', 'block_comment']);

interface WebTreeSitterParser {
  setLanguage(lang: unknown): void;
  parse(text: string): {
    rootNode: {
      namedChildren: Array<{
        type: string;
        startPosition: { row: number; column: number };
        endPosition: { row: number; column: number };
      }>;
    };
  };
}

let initState: 'pending' | 'ready' | 'unavailable' = 'pending';
let parser: WebTreeSitterParser | null = null;
let ParserClass: any = null;
const grammarCache = new Map<string, unknown>();

function findGrammarsDir(): string | null {
  // Prefer require.resolve of a known grammar; fall back to package.json dir.
  for (const probe of ['tree-sitter-wasms/out/tree-sitter-python.wasm', 'tree-sitter-wasms/package.json']) {
    try {
      const resolved = require.resolve(probe);
      const dir = probe.endsWith('package.json') ? join(dirname(resolved), 'out') : dirname(resolved);
      if (existsSync(dir)) return dir;
    } catch {
      // try next
    }
  }
  return null;
}

function findRuntimeWasm(): string | null {
  for (const probe of ['web-tree-sitter/tree-sitter.wasm', 'web-tree-sitter/package.json']) {
    try {
      const resolved = require.resolve(probe);
      const file = probe.endsWith('package.json') ? join(dirname(resolved), 'tree-sitter.wasm') : resolved;
      if (existsSync(file)) return file;
    } catch {
      // try next
    }
  }
  return null;
}

async function ensureParser(): Promise<WebTreeSitterParser | null> {
  if (initState === 'ready') return parser;
  if (initState === 'unavailable') return null;
  initState = 'unavailable'; // pessimistic until proven
  try {
    const mod: any = await import('web-tree-sitter');
    ParserClass = mod.default ?? mod;
    const runtimeWasm = findRuntimeWasm();
    await ParserClass.init(
      runtimeWasm ? { locateFile: () => runtimeWasm } : undefined
    );
    parser = new ParserClass() as WebTreeSitterParser;
    initState = 'ready';
    return parser;
  } catch {
    parser = null;
    return null;
  }
}

// Precondition: ensureParser() must have completed first — `ParserClass.Language`
// is undefined until `Parser.init()` has awaited in web-tree-sitter 0.20.8.
async function loadGrammar(language: string): Promise<unknown | null> {
  const basename = GRAMMAR_BY_LANGUAGE[language];
  if (!basename) return null;
  if (grammarCache.has(basename)) return grammarCache.get(basename);

  const dir = findGrammarsDir();
  if (!dir) return null;
  const wasmPath = join(dir, `tree-sitter-${basename}.wasm`);
  if (!existsSync(wasmPath)) return null;

  try {
    const lang = await ParserClass.Language.load(wasmPath);
    grammarCache.set(basename, lang);
    return lang;
  } catch {
    grammarCache.set(basename, null);
    return null;
  }
}

/** Reset cached state (for testing). */
export function resetWebTreeSitterChunker(): void {
  initState = 'pending';
  parser = null;
  ParserClass = null;
  grammarCache.clear();
}

/** True once an attempt established availability; false if WASM deps are absent. */
export function webTreeSitterAvailable(): boolean {
  return initState === 'ready';
}

/**
 * Split code at AST boundaries using pure-JS web-tree-sitter. Returns null (so the
 * caller falls back to regex) when the language is unsupported, the WASM deps are
 * missing, parsing fails, or the result would not exceed one piece.
 */
export async function splitCodeWithWebTreeSitter(
  text: string,
  maxTokens: number,
  overlapTokens: number,
  tokenEstimator: TokenEstimator,
  language?: string
): Promise<string[] | null> {
  if (!language) return null;
  const normalized = language.toLowerCase();
  if (!GRAMMAR_BY_LANGUAGE[normalized]) return null;

  const ts = await ensureParser();
  if (!ts) return null;

  const grammar = await loadGrammar(normalized);
  if (!grammar) return null;

  try {
    ts.setLanguage(grammar);
    const tree = ts.parse(text);
    const ranges: SymbolRange[] = [];
    for (const node of tree.rootNode.namedChildren) {
      if (SKIP_NODE_TYPES.has(node.type)) continue;
      const startLine = node.startPosition.row + 1;
      // Exclusive 0-based end line: if the node ends at column 0 the last content
      // line is the previous row; otherwise it is the end row itself. This col===0
      // special-case intentionally diverges from the Python sidecar's unconditional
      // end_point[0]+1 (structural-indexer.py), which over-extends by a line in the
      // col-0 case — so the two AST sources are not bit-identical by design.
      const endLine = node.endPosition.column === 0
        ? node.endPosition.row
        : node.endPosition.row + 1;
      if (endLine > startLine - 1) ranges.push({ startLine, endLine });
    }
    return buildChunksFromSymbolRanges(text, ranges, maxTokens, overlapTokens, tokenEstimator);
  } catch {
    return null;
  }
}
