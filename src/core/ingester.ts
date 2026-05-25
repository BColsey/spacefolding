import { randomUUID } from 'node:crypto';
import { extname, posix } from 'node:path';
import type { ChunkType, ContextChunk, TokenEstimator } from '../types/index.js';
import { classifyChunk } from './classifier.js';
import { maybeSplit, maybeSplitAsync, DEFAULT_CHUNKING_CONFIG } from './chunker.js';
import type { SplitResult } from './chunker.js';

const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.md': 'markdown',
  '.sql': 'sql',
  '.sh': 'shell',
  '.css': 'css',
  '.html': 'html',
};

const LANGUAGE_ALIASES: Record<string, string> = {
  cjs: 'javascript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  md: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  py: 'python',
  rs: 'rust',
  sh: 'shell',
  ts: 'typescript',
  tsx: 'typescript',
  yml: 'yaml',
};

export function inferLanguageFromPath(filePath: string): string | undefined {
  return EXT_TO_LANG[extname(normalizeContextPath(filePath)).toLowerCase()];
}

export function normalizeLanguage(language?: string): string | undefined {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) return undefined;
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

export function normalizeContextPath(filePath: string): string {
  const slashed = filePath.split(/[\\/]+/).join('/');
  const normalized = posix.normalize(slashed);
  return normalized === '.' ? '' : normalized;
}

export interface IngestResult {
  /** The primary chunk (parent if split, otherwise the chunk itself) */
  primary: ContextChunk;
  /** Full split result if chunking occurred, null otherwise */
  split: SplitResult | null;
}

export class ContextIngester {
  constructor(
    private tokenEstimator: TokenEstimator,
    private chunkingConfig = DEFAULT_CHUNKING_CONFIG
  ) {}

  /** Ingest text, auto-splitting if oversized. Returns primary chunk + split info. */
  ingestText(source: string, text: string, type?: ChunkType): IngestResult {
    const resolvedType = type ?? classifyChunk(text, source);
    const tokensEstimate = this.tokenEstimator.estimate(text);
    const split = maybeSplit(text, tokensEstimate, this.chunkingConfig, this.tokenEstimator, {
      source,
      type: resolvedType,
    });
    if (split) return { primary: split.parent, split };
    return {
      primary: {
        id: randomUUID(),
        source,
        type: resolvedType,
        text,
        timestamp: Date.now(),
        tokensEstimate,
        childrenIds: [],
        metadata: {},
      },
      split: null,
    };
  }

  /**
   * Async version that uses tree-sitter when CHUNK_TREE_SITTER=1.
   * Falls back to sync regex-based splitting if tree-sitter is unavailable.
   */
  async ingestTextAsync(source: string, text: string, type?: ChunkType): Promise<IngestResult> {
    const resolvedType = type ?? classifyChunk(text, source);
    const tokensEstimate = this.tokenEstimator.estimate(text);
    const split = await maybeSplitAsync(text, tokensEstimate, this.chunkingConfig, this.tokenEstimator, {
      source,
      type: resolvedType,
    });
    if (split) return { primary: split.parent, split };
    return {
      primary: {
        id: randomUUID(),
        source,
        type: resolvedType,
        text,
        timestamp: Date.now(),
        tokensEstimate,
        childrenIds: [],
        metadata: {},
      },
      split: null,
    };
  }

  ingestFile(
    filePath: string,
    content: string,
    language?: string,
    overrideType?: ChunkType
  ): IngestResult {
    const normalizedPath = normalizeContextPath(filePath);
    const lang = normalizeLanguage(language) ?? inferLanguageFromPath(normalizedPath);
    const type = overrideType ?? (classifyChunk(content, 'file') as ChunkType);
    const tokensEstimate = this.tokenEstimator.estimate(content);
    const split = maybeSplit(content, tokensEstimate, this.chunkingConfig, this.tokenEstimator, {
      source: 'file',
      type,
      path: normalizedPath,
      language: lang,
    });
    if (split) return { primary: split.parent, split };
    return {
      primary: {
        id: randomUUID(),
        source: 'file',
        type,
        text: content,
        timestamp: Date.now(),
        path: normalizedPath,
        language: lang,
        tokensEstimate,
        childrenIds: [],
        metadata: {},
      },
      split: null,
    };
  }

  /**
   * Async version that uses tree-sitter when CHUNK_TREE_SITTER=1.
   * Falls back to sync regex-based splitting if tree-sitter is unavailable.
   */
  async ingestFileAsync(
    filePath: string,
    content: string,
    language?: string,
    overrideType?: ChunkType
  ): Promise<IngestResult> {
    const normalizedPath = normalizeContextPath(filePath);
    const lang = normalizeLanguage(language) ?? inferLanguageFromPath(normalizedPath);
    const type = overrideType ?? (classifyChunk(content, 'file') as ChunkType);
    const tokensEstimate = this.tokenEstimator.estimate(content);
    const split = await maybeSplitAsync(content, tokensEstimate, this.chunkingConfig, this.tokenEstimator, {
      source: 'file',
      type,
      path: normalizedPath,
      language: lang,
    });
    if (split) return { primary: split.parent, split };
    return {
      primary: {
        id: randomUUID(),
        source: 'file',
        type,
        text: content,
        timestamp: Date.now(),
        path: normalizedPath,
        language: lang,
        tokensEstimate,
        childrenIds: [],
        metadata: {},
      },
      split: null,
    };
  }

  ingestDiff(diffText: string): ContextChunk {
    return {
      id: randomUUID(),
      source: 'diff',
      type: 'diff',
      text: diffText,
      timestamp: Date.now(),
      tokensEstimate: this.tokenEstimator.estimate(diffText),
      childrenIds: [],
      metadata: {},
    };
  }

  ingestConversation(
    messages: { role: string; content: string }[]
  ): ContextChunk[] {
    return messages.map((msg) => {
      const source = 'conversation';
      const type = classifyChunk(msg.content, source) as ChunkType;
      return {
        id: randomUUID(),
        source,
        type,
        text: msg.content,
        timestamp: Date.now(),
        tokensEstimate: this.tokenEstimator.estimate(msg.content),
        childrenIds: [],
        metadata: { role: msg.role },
      };
    });
  }

  ingestDirectory(
    basePath: string,
    files: { path: string; content: string }[]
  ): IngestResult[] {
    return files.map((f) =>
      this.ingestFile(`${normalizeContextPath(basePath)}/${normalizeContextPath(f.path)}`, f.content)
    );
  }
}
