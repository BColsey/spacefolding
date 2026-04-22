import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { ChunkType, ContextChunk, TokenEstimator } from '../types/index.js';
import { classifyChunk } from './classifier.js';

const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
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

function detectLanguage(filePath: string): string | undefined {
  return EXT_TO_LANG[extname(filePath).toLowerCase()];
}

export class ContextIngester {
  constructor(private tokenEstimator: TokenEstimator) {}

  ingestText(source: string, text: string, type?: ChunkType): ContextChunk {
    const resolvedType = type ?? classifyChunk(text, source);
    return {
      id: randomUUID(),
      source,
      type: resolvedType,
      text,
      timestamp: Date.now(),
      tokensEstimate: this.tokenEstimator.estimate(text),
      childrenIds: [],
      metadata: {},
    };
  }

  ingestFile(
    filePath: string,
    content: string,
    language?: string,
    overrideType?: ChunkType
  ): ContextChunk {
    const lang = language ?? detectLanguage(filePath);
    const type = overrideType ?? (classifyChunk(content, 'file') as ChunkType);
    return {
      id: randomUUID(),
      source: 'file',
      type,
      text: content,
      timestamp: Date.now(),
      path: filePath,
      language: lang,
      tokensEstimate: this.tokenEstimator.estimate(content),
      childrenIds: [],
      metadata: {},
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
  ): ContextChunk[] {
    return files.map((f) =>
      this.ingestFile(`${basePath}/${f.path}`, f.content)
    );
  }
}
