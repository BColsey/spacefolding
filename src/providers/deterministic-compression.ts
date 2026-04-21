import type { CompressionProvider, ContextChunk, TaskDescription, CompressionResult } from '../types/index.js';

export class DeterministicCompressionProvider implements CompressionProvider {
  async compress(task: TaskDescription, chunks: ContextChunk[]): Promise<CompressionResult> {
    const constraints: string[] = [];
    const facts: string[] = [];
    const codeRefs: string[] = [];
    const sourceChunkIds: string[] = [];

    for (const chunk of chunks) {
      sourceChunkIds.push(chunk.id);

      if (chunk.type === 'constraint') {
        constraints.push(chunk.text.trim());
      } else if (chunk.type === 'fact') {
        // Keep first sentence only
        const firstSentence = chunk.text.split(/[.!?]\s/)[0];
        facts.push(firstSentence || chunk.text.trim());
      } else if (chunk.type === 'code') {
        const ref = chunk.path
          ? `${chunk.path}${chunk.language ? ` (${chunk.language})` : ''}`
          : `code:${chunk.id.slice(0, 8)}`;
        codeRefs.push(ref);
      }
    }

    const parts: string[] = [`Task: ${task.text}`];
    if (constraints.length > 0) {
      parts.push(`Constraints: ${constraints.join('; ')}`);
    }
    if (facts.length > 0) {
      parts.push(`Facts: ${facts.join('; ')}`);
    }
    if (codeRefs.length > 0) {
      parts.push(`Code references: ${codeRefs.join(', ')}`);
    }
    parts.push(`From ${chunks.length} chunks (${new Set(sourceChunkIds).size} unique)`);

    return {
      summary: parts.join('. ') + '.',
      retainedFacts: facts,
      retainedConstraints: constraints,
      sourceChunkIds,
    };
  }
}
