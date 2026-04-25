import { randomUUID } from 'node:crypto';
import type { ChunkType, ContextChunk, TokenEstimator } from '../types/index.js';
import { classifyChunk } from './classifier.js';

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

  const strategy = config.strategy === 'auto'
    ? detectStrategy(overrides.path, overrides.language, text)
    : config.strategy;

  const pieces = split(text, strategy, config.maxTokens, config.overlapTokens, tokenEstimator, overrides.language);
  if (pieces.length <= 1) return null;

  const parentId = randomUUID();
  const parent: ContextChunk = {
    id: parentId,
    source: overrides.source,
    type: overrides.type ?? classifyChunk(text, overrides.source),
    text: `[split from ${pieces.length} sub-chunks] ${text.slice(0, 200)}…`,
    timestamp: Date.now(),
    path: overrides.path,
    language: overrides.language,
    tokensEstimate,
    childrenIds: [],
    metadata: { split: true, childCount: pieces.length, strategy },
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
    metadata: { splitIndex: index, splitTotal: pieces.length },
  }));

  parent.childrenIds = children.map((c) => c.id);

  return { parent, children };
}

function detectStrategy(path?: string, language?: string, _text?: string): ChunkingConfig['strategy'] {
  if (language === 'markdown' || path?.endsWith('.md')) return 'markdown';
  if (language && ['typescript', 'javascript', 'python', 'rust', 'go', 'java'].includes(language)) return 'code';
  if (path) {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java'].includes(ext)) return 'code';
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
  if (separators.length === 0) return splitByChars(text, maxTokens, overlapTokens, tokenEstimator);

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

  return applyOverlap(chunks, overlapTokens, tokenEstimator);
}

function splitByChars(
  text: string,
  maxTokens: number,
  overlapTokens: number,
  tokenEstimator: TokenEstimator
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

  // Separate imports from body
  const imports: string[] = [];
  const body: string[] = [];
  let pastImports = false;

  for (const line of lines) {
    if (!pastImports && /^\s*(import\s|from\s|require\s*\(|#include\s|use\s)/.test(line)) {
      imports.push(line);
    } else {
      pastImports = true;
      body.push(line);
    }
  }

  const importBlock = imports.join('\n');
  const bodyText = body.join('\n');

  if (tokenEstimator.estimate(bodyText) <= maxTokens) return [text];

  // Split at function/class boundaries
  const boundaries = findCodeBoundaries(body);
  if (boundaries.size === 0) {
    // No structural boundaries found — fall back to recursive
    return splitRecursive(text, maxTokens, overlapTokens, tokenEstimator);
  }
  const chunks: string[] = [];
  let currentLines: string[] = [];
  let currentTokens = tokenEstimator.estimate(importBlock);

  for (const line of body) {
    const lineTokens = tokenEstimator.estimate(line);
    if (boundaries.has(line) && currentTokens + lineTokens > maxTokens && currentLines.length > 0) {
      // Start a new chunk — prepend imports to each chunk
      chunks.push(importBlock + '\n\n' + currentLines.join('\n'));
      currentLines = [line];
      currentTokens = tokenEstimator.estimate(importBlock) + lineTokens;
    } else {
      currentLines.push(line);
      currentTokens += lineTokens;
    }
  }

  if (currentLines.length > 0) {
    chunks.push(importBlock + '\n\n' + currentLines.join('\n'));
  }

  return applyOverlap(chunks, overlapTokens, tokenEstimator);
}

function findCodeBoundaries(lines: string[]): Set<string> {
  const boundaries = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(export\s+)?(async\s+)?function\s+\w+/.test(trimmed)) boundaries.add(line);
    else if (/^class\s+\w+/.test(trimmed)) boundaries.add(line);
    else if (/^(export\s+)?interface\s+\w+/.test(trimmed)) boundaries.add(line);
    else if (/^(export\s+)?type\s+\w+\s*(<|=)/.test(trimmed)) boundaries.add(line);
    else if (/^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?\(/.test(trimmed)) boundaries.add(line);
    else if (/^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?function/.test(trimmed)) boundaries.add(line);
    else if (/^(def|class|async def)\s+\w+/.test(trimmed)) boundaries.add(line);
    else if (/^(pub\s+)?(fn|struct|impl|trait|enum)\s+\w+/.test(trimmed)) boundaries.add(line);
    else if (/^(func|type|interface)\s+\w+/.test(trimmed)) boundaries.add(line);
  }
  return boundaries;
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

  return applyOverlap(chunks, overlapTokens, tokenEstimator);
}

// ── Overlap ────────────────────────────────────────────────────

function applyOverlap(
  chunks: string[],
  overlapTokens: number,
  tokenEstimator: TokenEstimator
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
