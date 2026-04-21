import type { ChunkType } from '../types/index.js';

const CONSTRAINT_WORDS = /^(must|shall|should|need to|make sure|ensure|always|never|require|mandatory|critical)\b/i;
const INSTRUCTION_WORDS = /^(add|remove|fix|implement|refactor|change|update|create|delete|move|rename|extract|split|merge)\b/i;
const LOG_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const DIFF_HEADER = /^diff --git|^--- [ab]\//;
const CODE_KEYWORDS = /\b(function|class|import|export|const|let|var|def|async|return|interface|type |enum)\b/;

/** Classify a chunk's type from its text and source */
export function classifyChunk(text: string, source: string): ChunkType {
  // Diff detection
  if (source.includes('diff') || DIFF_HEADER.test(text)) return 'diff';

  // Log detection
  if (source.includes('log') || LOG_PATTERN.test(text)) return 'log';

  // Summary source
  if (source === 'summary') return 'summary';

  // Reference/documentation source
  if (source.includes('reference') || source.includes('doc')) return 'reference';

  // Conversation source: constraint vs instruction
  if (source === 'conversation') {
    if (CONSTRAINT_WORDS.test(text)) return 'constraint';
    if (INSTRUCTION_WORDS.test(text)) return 'instruction';
    return 'fact';
  }

  // Code detection for file sources
  if (source.includes('file') && CODE_KEYWORDS.test(text)) return 'code';

  // Default
  return 'fact';
}

/** Classify multiple chunks */
export function classifyChunks(
  chunks: { text: string; source: string }[]
): ChunkType[] {
  return chunks.map((c) => classifyChunk(c.text, c.source));
}
