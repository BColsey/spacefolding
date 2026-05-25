import type { CodeSymbol, TokenEstimator } from '../types/index.js';
import { StructuralIndexer } from '../providers/structural-indexer.js';

/** Tracks lazy initialization state across calls. */
let indexerInstance: StructuralIndexer | null = null;
let initAttempted = false;
let available = false;

/**
 * Get (or lazily create) the structural indexer.
 * Returns null if tree-sitter is unavailable.
 */
function getIndexer(): StructuralIndexer | null {
  if (initAttempted) return available ? indexerInstance : null;
  initAttempted = true;

  if (process.env.CHUNK_TREE_SITTER !== '1') return null;

  indexerInstance = new StructuralIndexer({ timeoutMs: 5000 });
  available = true;
  return indexerInstance;
}

/** Reset state (for testing). */
export function resetTreeSitterChunker(): void {
  indexerInstance = null;
  initAttempted = false;
  available = false;
}

/**
 * Use tree-sitter to split code at AST boundaries.
 *
 * Calls the Python structural-indexer to get symbol ranges (functions, classes,
 * methods, etc.) and splits code along those boundaries. Symbols that fit within
 * maxTokens are kept whole; oversized symbols are recursively split.
 *
 * Returns null if tree-sitter is unavailable, so caller can fall back to regex.
 */
export async function splitCodeWithTreeSitter(
  text: string,
  maxTokens: number,
  overlapTokens: number,
  tokenEstimator: TokenEstimator,
  language?: string
): Promise<string[] | null> {
  const indexer = getIndexer();
  if (!indexer) return null;

  try {
    const extraction = await indexer.extract(text, language);
    if (extraction.backend !== 'tree-sitter') return null;

    const symbols = extraction.symbols;
    if (symbols.length === 0) return null;

    const lines = text.split('\n');
    const importEnd = findImportEnd(lines);
    const importBlock = lines.slice(0, importEnd).join('\n');
    const bodyStart = importEnd;

    // Build sorted, non-overlapping symbol ranges
    const ranges = buildNonOverlappingRanges(symbols, bodyStart);

    // Also capture any code between import end and first symbol, and trailing code
    const pieces = buildPieces(lines, ranges, bodyStart, maxTokens, tokenEstimator);

    if (pieces.length <= 1) return null;

    const chunked = packPiecesWithPrefix(pieces, importBlock, maxTokens, tokenEstimator);

    return applyOverlap(chunked, overlapTokens);
  } catch {
    // Any error means we fall back to regex
    return null;
  }
}

/**
 * Find the line index where imports end.
 * Very similar to the logic in splitCode() already.
 */
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

interface LineRange {
  start: number; // inclusive, 0-based line index
  end: number;   // exclusive, 0-based line index
  symbol: CodeSymbol;
}

/**
 * Given symbols from tree-sitter, build non-overlapping sorted ranges.
 * For nested structures (method inside class), keep the outermost container
 * as a single unit unless it exceeds maxTokens.
 */
function buildNonOverlappingRanges(
  symbols: CodeSymbol[],
  bodyStart: number
): LineRange[] {
  // Sort by startLine, then by size descending (prefer larger containers)
  const sorted = [...symbols].sort((a, b) => {
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    // If same start, prefer the one that ends later (outer container)
    return b.endLine - a.endLine;
  });

  const ranges: LineRange[] = [];
  let lastEnd = bodyStart; // 0-based, exclusive

  for (const sym of sorted) {
    const start = sym.startLine - 1; // convert to 0-based
    const end = sym.endLine;         // endLine is already 1-based, so as exclusive index it's correct

    if (end <= lastEnd) continue; // fully contained in previous range

    // If this symbol starts before the last ended, extend or skip
    const clampedStart = Math.max(start, lastEnd);
    if (clampedStart >= end) continue;

    ranges.push({ start: clampedStart, end, symbol: sym });
    lastEnd = end;
  }

  return ranges;
}

/**
 * Build text pieces from the line ranges, including gaps between symbols.
 * Each piece is one AST node (or a group of small adjacent nodes).
 */
function buildPieces(
  lines: string[],
  ranges: LineRange[],
  bodyStart: number,
  maxTokens: number,
  tokenEstimator: TokenEstimator
): string[] {
  const pieces: string[] = [];
  let pos = bodyStart;

  for (const range of ranges) {
    // Capture any gap between pos and range.start as a preamble piece
    if (range.start > pos) {
      const gapText = lines.slice(pos, range.start).join('\n').trim();
      if (gapText) pieces.push(gapText);
    }

    const rangeText = lines.slice(range.start, range.end).join('\n');
    const rangeTokens = tokenEstimator.estimate(rangeText);

    if (rangeTokens <= maxTokens) {
      pieces.push(rangeText);
    } else {
      // Oversized symbol: split it by lines
      const subPieces = splitOversizedRange(lines, range.start, range.end, maxTokens, tokenEstimator);
      pieces.push(...subPieces);
    }

    pos = range.end;
  }

  // Trailing code after last symbol
  if (pos < lines.length) {
    const trailing = lines.slice(pos).join('\n').trim();
    if (trailing) pieces.push(trailing);
  }

  return pieces;
}

/**
 * Split an oversized AST node range into line-based chunks.
 * Tries to break at blank lines to avoid splitting mid-expression.
 */
function splitOversizedRange(
  lines: string[],
  start: number,
  end: number,
  maxTokens: number,
  tokenEstimator: TokenEstimator
): string[] {
  const pieces: string[] = [];
  let currentLines: string[] = [];
  let currentTokens = 0;

  for (let i = start; i < end; i++) {
    const line = lines[i];
    const lineTokens = tokenEstimator.estimate(line);

    if (currentTokens + lineTokens > maxTokens && currentLines.length > 0) {
      // Try to break at the last blank line in current batch
      const lastBlank = currentLines.reduce((acc, l, idx) => l.trim() === '' ? idx : acc, -1);
      if (lastBlank > 0) {
        pieces.push(currentLines.slice(0, lastBlank).join('\n'));
        currentLines = currentLines.slice(lastBlank + 1);
        currentTokens = tokenEstimator.estimate(currentLines.join('\n'));
      } else {
        pieces.push(currentLines.join('\n'));
        currentLines = [];
        currentTokens = 0;
      }
    }

    currentLines.push(line);
    currentTokens += lineTokens;
  }

  if (currentLines.length > 0) {
    pieces.push(currentLines.join('\n'));
  }

  return pieces;
}

function packPiecesWithPrefix(
  pieces: string[],
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

  for (const piece of pieces) {
    if (!piece.trim()) continue;

    const candidate = [...current, piece].join('\n\n');
    if (tokenEstimator.estimate(formatCodeChunk(importBlock, candidate)) <= maxTokens) {
      current.push(piece);
      continue;
    }

    flushCurrent();
    if (tokenEstimator.estimate(formatCodeChunk(importBlock, piece)) <= maxTokens) {
      current.push(piece);
      continue;
    }

    chunks.push(...splitOversizedPiece(piece, importBlock, maxTokens, tokenEstimator));
  }

  flushCurrent();
  return chunks;
}

function splitOversizedPiece(
  piece: string,
  importBlock: string,
  maxTokens: number,
  tokenEstimator: TokenEstimator
): string[] {
  const prefix = codePrefix(importBlock);
  if (!prefix || tokenEstimator.estimate(prefix) >= maxTokens) {
    return splitTextByLines(piece, maxTokens, tokenEstimator);
  }

  const bodyMaxTokens = Math.max(1, maxTokens - tokenEstimator.estimate(prefix));
  return splitTextByLines(piece, bodyMaxTokens, tokenEstimator)
    .map((subPiece) => formatCodeChunk(importBlock, subPiece));
}

function splitTextByLines(
  text: string,
  maxTokens: number,
  tokenEstimator: TokenEstimator
): string[] {
  const chunks: string[] = [];
  let current: string[] = [];

  const flushCurrent = () => {
    if (current.length === 0) return;
    chunks.push(current.join('\n'));
    current = [];
  };

  for (const line of text.split('\n')) {
    const candidate = [...current, line].join('\n');
    if (tokenEstimator.estimate(candidate) <= maxTokens) {
      current.push(line);
      continue;
    }

    flushCurrent();
    if (tokenEstimator.estimate(line) <= maxTokens) {
      current.push(line);
      continue;
    }

    chunks.push(...splitLongLine(line, maxTokens, tokenEstimator));
  }

  flushCurrent();
  return chunks;
}

function splitLongLine(
  line: string,
  maxTokens: number,
  tokenEstimator: TokenEstimator
): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < line.length) {
    let end = Math.min(line.length, start + Math.max(1, maxTokens * 4));
    while (end > start + 1 && tokenEstimator.estimate(line.slice(start, end)) > maxTokens) {
      end--;
    }
    chunks.push(line.slice(start, end));
    start = end;
  }

  return chunks;
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

/**
 * Apply overlap between chunks (same logic as in chunker.ts but for async context).
 */
function applyOverlap(
  chunks: string[],
  overlapTokens: number
): string[] {
  if (chunks.length <= 1 || overlapTokens <= 0) return chunks;

  const result: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];
    if (i > 0) {
      const prev = chunks[i - 1];
      const overlapChars = overlapTokens * 4;
      const overlap = prev.slice(-overlapChars);
      const lastNewline = overlap.indexOf('\n');
      const trimmedOverlap = lastNewline >= 0 ? overlap.slice(lastNewline + 1) : overlap;
      if (trimmedOverlap.trim()) {
        chunk = `[...]\n${trimmedOverlap}${chunk}`;
      }
    }
    result.push(chunk);
  }

  return result;
}
