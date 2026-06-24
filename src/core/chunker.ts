import { createHash, randomUUID } from 'node:crypto';
import type { ChunkType, ContextChunk, TokenEstimator } from '../types/index.js';
import { classifyChunk } from './classifier.js';
import { splitCodeWithTreeSitter } from './tree-sitter-chunker.js';
import { splitCodeWithWebTreeSitter } from './web-tree-sitter-chunker.js';

export interface ChunkingConfig {
  maxTokens: number;
  overlapTokens: number;
  strategy: 'auto' | 'recursive' | 'code' | 'markdown' | 'semantic';
}

export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  maxTokens: parseInt(process.env.CHUNK_MAX_TOKENS ?? '2000', 10),
  overlapTokens: parseInt(process.env.CHUNK_OVERLAP_TOKENS ?? '200', 10),
  strategy: (process.env.CHUNK_STRATEGY as ChunkingConfig['strategy']) ?? 'auto',
};

export interface SplitResult {
  parent: ContextChunk;
  children: ContextChunk[];
}

/**
 * Split oversized text into sub-chunks with parent-child linking.
 * Returns null if the text doesn't need splitting.
 * Synchronous — uses regex-based splitting only.
 */
export function maybeSplit(
  text: string,
  tokensEstimate: number,
  config: ChunkingConfig,
  tokenEstimator: TokenEstimator,
  overrides: {
    source: string;
    type?: ChunkType;
    path?: string;
    language?: string;
  }
): SplitResult | null {
  if (tokensEstimate <= config.maxTokens) return null;
  return doSplit(text, config, tokenEstimator, overrides);
}

/**
 * Async version that tries tree-sitter structural splitting when
 * CHUNK_TREE_SITTER is set: `1` uses the Python structural-indexer sidecar,
 * `js` uses the pure-JS web-tree-sitter (WASM) source with no subprocess. Either
 * falls back to the regex code splitter if unavailable. Returns null if the text
 * doesn't need splitting.
 */
export async function maybeSplitAsync(
  text: string,
  tokensEstimate: number,
  config: ChunkingConfig,
  tokenEstimator: TokenEstimator,
  overrides: {
    source: string;
    type?: ChunkType;
    path?: string;
    language?: string;
  }
): Promise<SplitResult | null> {
  if (tokensEstimate <= config.maxTokens) return null;

  const strategy = config.strategy === 'auto'
    ? detectStrategy(overrides.path, overrides.language, text)
    : config.strategy;

  // Try AST-boundary splitting for code when enabled. CHUNK_TREE_SITTER=1 uses
  // the Python sidecar; CHUNK_TREE_SITTER=js uses pure-JS web-tree-sitter (WASM,
  // no subprocess). Both fall through to the regex splitter on any failure.
  const astMode = process.env.CHUNK_TREE_SITTER;
  if (strategy === 'code' && (astMode === '1' || astMode === 'js')) {
    const astPieces = astMode === 'js'
      ? await splitCodeWithWebTreeSitter(
          text, config.maxTokens, config.overlapTokens, tokenEstimator, overrides.language
        )
      : await splitCodeWithTreeSitter(
          text, config.maxTokens, config.overlapTokens, tokenEstimator, overrides.language
        );
    if (astPieces && astPieces.length > 1) {
      return buildSplitResult(text, astPieces, config, tokenEstimator, overrides, 'tree-sitter');
    }
    // Fall through to regex if the AST source returns null or only 1 piece
  }

  return doSplit(text, config, tokenEstimator, overrides);
}

/**
 * Internal sync split implementation shared by maybeSplit and maybeSplitAsync fallback.
 */
function doSplit(
  text: string,
  config: ChunkingConfig,
  tokenEstimator: TokenEstimator,
  overrides: {
    source: string;
    type?: ChunkType;
    path?: string;
    language?: string;
  }
): SplitResult | null {
  const strategy = config.strategy === 'auto'
    ? detectStrategy(overrides.path, overrides.language, text)
    : config.strategy;

  const pieces = split(text, strategy, config.maxTokens, config.overlapTokens, tokenEstimator, overrides.language);
  if (pieces.length <= 1) return null;

  return buildSplitResult(text, pieces, config, tokenEstimator, overrides, strategy);
}

function buildSplitResult(
  text: string,
  pieces: string[],
  _config: ChunkingConfig,
  tokenEstimator: TokenEstimator,
  overrides: {
    source: string;
    type?: ChunkType;
    path?: string;
    language?: string;
  },
  strategy: string
): SplitResult {
  const parentId = randomUUID();
  const parentText = `[split from ${pieces.length} sub-chunks] ${text.slice(0, 200)}...`;
  const parent: ContextChunk = {
    id: parentId,
    source: overrides.source,
    type: overrides.type ?? classifyChunk(text, overrides.source),
    text: parentText,
    timestamp: Date.now(),
    path: overrides.path,
    language: overrides.language,
    tokensEstimate: tokenEstimator.estimate(parentText),
    childrenIds: [],
    metadata: { split: true, childCount: pieces.length, strategy, contentHash: hashContent(text) },
  };

  const children: ContextChunk[] = pieces.map((piece, index) => ({
    id: randomUUID(),
    source: overrides.source,
    type: overrides.type ?? classifyChunk(piece, overrides.source),
    text: piece,
    timestamp: Date.now(),
    path: overrides.path,
    language: overrides.language,
    tokensEstimate: tokenEstimator.estimate(piece),
    parentId,
    childrenIds: [],
    metadata: { splitIndex: index, splitTotal: pieces.length, contentHash: hashContent(piece) },
  }));

  parent.childrenIds = children.map((c) => c.id);

  return { parent, children };
}

function detectStrategy(path?: string, language?: string, _text?: string): ChunkingConfig['strategy'] {
  const normalizedLanguage = language?.toLowerCase();
  if (normalizedLanguage === 'markdown' || path?.endsWith('.md')) return 'markdown';
  if (normalizedLanguage && ['typescript', 'javascript', 'python', 'rust', 'go', 'java'].includes(normalizedLanguage)) return 'code';
  if (path) {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    if (['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java'].includes(ext)) return 'code';
    if (ext === 'md') return 'markdown';
  }
  return 'recursive';
}

function split(
  text: string,
  strategy: ChunkingConfig['strategy'],
  maxTokens: number,
  overlapTokens: number,
  tokenEstimator: TokenEstimator,
  language?: string
): string[] {
  switch (strategy) {
    case 'code':
      return splitCode(text, maxTokens, overlapTokens, tokenEstimator, language);
    case 'markdown':
      return splitMarkdown(text, maxTokens, overlapTokens, tokenEstimator);
    case 'semantic':
    case 'recursive':
    default:
      return splitRecursive(text, maxTokens, overlapTokens, tokenEstimator);
  }
}

// ── Recursive Text Splitter ────────────────────────────────────

function splitRecursive(
  text: string,
  maxTokens: number,
  overlapTokens: number,
  tokenEstimator: TokenEstimator
): string[] {
  const separators = ['\n\n', '\n', '. ', '? ', '! ', '; ', ', ', ' '];
  return splitWithSeparators(text, separators, maxTokens, overlapTokens, tokenEstimator);
}

function splitWithSeparators(
  text: string,
  separators: string[],
  maxTokens: number,
  overlapTokens: number,
  tokenEstimator: TokenEstimator
): string[] {
  if (tokenEstimator.estimate(text) <= maxTokens) return [text];
  if (separators.length === 0) return splitByChars(text, maxTokens, overlapTokens);

  const sep = separators[0];
  const remaining = separators.slice(1);
  const parts = text.split(sep);
  const chunks: string[] = [];
  let current = '';

  for (let i = 0; i < parts.length; i++) {
    const candidate = current ? current + sep + parts[i] : parts[i];

    if (tokenEstimator.estimate(candidate) <= maxTokens) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      // If a single part is too large, split it further
      if (tokenEstimator.estimate(parts[i]) > maxTokens) {
        const subChunks = splitWithSeparators(parts[i], remaining, maxTokens, overlapTokens, tokenEstimator);
        chunks.push(...subChunks);
        current = '';
      } else {
        current = parts[i];
      }
    }
  }

  if (current) chunks.push(current);

  return applyOverlap(chunks, overlapTokens);
}

function splitByChars(
  text: string,
  maxTokens: number,
  overlapTokens: number
): string[] {
  const charsPerToken = 4;
  const maxChars = maxTokens * charsPerToken;
  const overlapChars = overlapTokens * charsPerToken;
  const chunks: string[] = [];

  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    chunks.push(text.slice(start, end));
    start = end - overlapChars;
    if (start >= text.length) break;
    if (end >= text.length) break;
  }

  return chunks;
}

// ── Code Splitter ──────────────────────────────────────────────

function splitCode(
  text: string,
  maxTokens: number,
  overlapTokens: number,
  tokenEstimator: TokenEstimator,
  _language?: string
): string[] {
  const lines = text.split('\n');
  if (lines.length === 0) return [text];

  const importEnd = findImportEnd(lines);
  const importBlock = lines.slice(0, importEnd).join('\n').trimEnd();
  const body = lines.slice(importEnd);
  const bodyText = body.join('\n').trim();

  if (tokenEstimator.estimate(formatCodeChunk(importBlock, bodyText)) <= maxTokens) return [text];

  // Split at function/class boundaries
  const segments = findCodeSegments(body);
  if (!segments.some((segment) => segment.isBoundary)) {
    // No structural boundaries found — fall back to recursive
    return splitRecursive(text, maxTokens, overlapTokens, tokenEstimator);
  }

  const chunks = packCodeSegments(
    segments.map((segment) => segment.text),
    importBlock,
    maxTokens,
    tokenEstimator
  );

  return applyOverlap(chunks, overlapTokens);
}

interface CodeSegment {
  text: string;
  isBoundary: boolean;
}

function findImportEnd(lines: string[]): number {
  let end = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0 && end === i) {
      end = i + 1;
      continue;
    }
    if (/^\s*(import\s|from\s|require\s*\(|#include\s|use\s)/.test(lines[i])) {
      end = i + 1;
    } else {
      break;
    }
  }
  return end;
}

function findCodeSegments(lines: string[]): CodeSegment[] {
  const boundaries = findCodeBoundaryIndexes(lines);
  if (boundaries.length === 0) {
    const text = lines.join('\n').trim();
    return text ? [{ text, isBoundary: false }] : [];
  }

  const segments: CodeSegment[] = [];
  let cursor = 0;

  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i];
    if (start > cursor) {
      const preamble = lines.slice(cursor, start).join('\n').trim();
      if (preamble) segments.push({ text: preamble, isBoundary: false });
    }

    const end = boundaries[i + 1] ?? lines.length;
    const declaration = lines.slice(start, end).join('\n').trim();
    if (declaration) segments.push({ text: declaration, isBoundary: true });
    cursor = end;
  }

  if (cursor < lines.length) {
    const trailing = lines.slice(cursor).join('\n').trim();
    if (trailing) segments.push({ text: trailing, isBoundary: false });
  }

  return segments;
}

function findCodeBoundaryIndexes(lines: string[]): number[] {
  const boundaries: number[] = [];
  const seen = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || /^\s/.test(line)) continue;
    if (!isCodeBoundary(trimmed)) continue;

    let start = i;
    while (start > 0 && lines[start - 1].trim().startsWith('@')) start--;
    if (!seen.has(start)) {
      boundaries.push(start);
      seen.add(start);
    }
  }

  return boundaries;
}

function isCodeBoundary(trimmed: string): boolean {
  return /^(export\s+)?(default\s+)?(async\s+)?function\s+\w+/.test(trimmed)
    || /^(export\s+)?(default\s+)?(abstract\s+)?class\s+\w+/.test(trimmed)
    || /^(export\s+)?(default\s+)?interface\s+\w+/.test(trimmed)
    || /^(export\s+)?type\s+\w+\s*(<|=)/.test(trimmed)
    || /^(export\s+)?enum\s+\w+/.test(trimmed)
    || /^(export\s+)?(namespace|module)\s+\w+/.test(trimmed)
    || /^(export\s+)?(const|let|var)\s+\w+\s*[:=]\s*(async\s*)?(\(|function|\w+\s*=>)/.test(trimmed)
    || /^(def|class|async def)\s+\w+/.test(trimmed)
    || /^(pub\s+)?(fn|struct|impl|trait|enum)\s+\w+/.test(trimmed)
    || /^(func|type|interface)\s+\w+/.test(trimmed)
    || /^(public\s+)?(abstract\s+|final\s+)?(class|interface|enum)\s+\w+/.test(trimmed);
}

function packCodeSegments(
  segments: string[],
  importBlock: string,
  maxTokens: number,
  tokenEstimator: TokenEstimator
): string[] {
  const chunks: string[] = [];
  let current: string[] = [];

  const flushCurrent = () => {
    if (current.length === 0) return;
    chunks.push(formatCodeChunk(importBlock, current.join('\n\n')));
    current = [];
  };

  for (const segment of segments) {
    if (!segment.trim()) continue;

    const candidate = [...current, segment].join('\n\n');
    if (tokenEstimator.estimate(formatCodeChunk(importBlock, candidate)) <= maxTokens) {
      current.push(segment);
      continue;
    }

    flushCurrent();
    if (tokenEstimator.estimate(formatCodeChunk(importBlock, segment)) <= maxTokens) {
      current.push(segment);
      continue;
    }

    chunks.push(...splitOversizedCodeSegment(segment, importBlock, maxTokens, tokenEstimator));
  }

  flushCurrent();
  return chunks.length > 0 ? chunks : [];
}

function splitOversizedCodeSegment(
  segment: string,
  importBlock: string,
  maxTokens: number,
  tokenEstimator: TokenEstimator
): string[] {
  const prefix = codePrefix(importBlock);
  if (!prefix || tokenEstimator.estimate(prefix) >= maxTokens) {
    return splitRecursive(segment, maxTokens, 0, tokenEstimator);
  }

  const bodyMaxTokens = Math.max(1, maxTokens - tokenEstimator.estimate(prefix));
  const pieces = splitRecursive(segment, bodyMaxTokens, 0, tokenEstimator);
  return pieces.map((piece) => formatCodeChunk(importBlock, piece));
}

function codePrefix(importBlock: string): string {
  const trimmed = importBlock.trim();
  return trimmed ? `${trimmed}\n\n` : '';
}

function formatCodeChunk(importBlock: string, body: string): string {
  const prefix = codePrefix(importBlock);
  const trimmedBody = body.trim();
  if (!prefix) return trimmedBody;
  return trimmedBody ? `${prefix}${trimmedBody}` : importBlock.trim();
}

function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// ── Markdown Splitter ──────────────────────────────────────────

function splitMarkdown(
  text: string,
  maxTokens: number,
  overlapTokens: number,
  tokenEstimator: TokenEstimator
): string[] {
  // Split on ## or ### headers, keep the header with the section
  const sections = text.split(/(?=^#{1,3}\s)/m);
  if (sections.length <= 1) return splitRecursive(text, maxTokens, overlapTokens, tokenEstimator);

  const chunks: string[] = [];
  let current = '';

  for (const section of sections) {
    const candidate = current ? current + '\n\n' + section.trim() : section.trim();
    if (tokenEstimator.estimate(candidate) <= maxTokens) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      // If a single section is too large, split it recursively
      if (tokenEstimator.estimate(section) > maxTokens) {
        const subChunks = splitRecursive(section.trim(), maxTokens, overlapTokens, tokenEstimator);
        chunks.push(...subChunks);
        current = '';
      } else {
        current = section.trim();
      }
    }
  }

  if (current) chunks.push(current);

  return applyOverlap(chunks, overlapTokens);
}

// ── Overlap ────────────────────────────────────────────────────

function applyOverlap(
  chunks: string[],
  overlapTokens: number
): string[] {
  if (chunks.length <= 1 || overlapTokens <= 0) return chunks;

  const result: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];
    if (i > 0) {
      // Prepend overlap from previous chunk
      const prev = chunks[i - 1];
      const overlapChars = overlapTokens * 4;
      const overlap = prev.slice(-overlapChars);
      const lastNewline = overlap.indexOf('\n');
      const trimmedOverlap = lastNewline >= 0 ? overlap.slice(lastNewline + 1) : overlap;
      if (trimmedOverlap.trim()) {
        chunk = `[…]\n${trimmedOverlap}${chunk}`;
      }
    }
    result.push(chunk);
  }

  return result;
}
