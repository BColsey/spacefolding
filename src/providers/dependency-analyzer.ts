import type { DependencyAnalyzer, ContextChunk, DependencyLink } from '../types/index.js';

export class SimpleDependencyAnalyzer implements DependencyAnalyzer {
  analyze(chunks: ContextChunk[]): DependencyLink[] {
    const links: DependencyLink[] = [];
    const chunkMap = new Map(chunks.map((c) => [c.id, c]));

    for (const chunkA of chunks) {
      // Rule 1: If A's text contains B's path -> references
      for (const chunkB of chunks) {
        if (chunkA.id === chunkB.id) continue;
        if (chunkB.path && chunkA.text.includes(chunkB.path)) {
          links.push({
            fromId: chunkA.id,
            toId: chunkB.id,
            type: 'references',
            weight: 0.7,
          });
        }
      }

      // Rule 2: Parent-child relationship -> contains
      if (chunkA.parentId && chunkMap.has(chunkA.parentId)) {
        links.push({
          fromId: chunkA.parentId,
          toId: chunkA.id,
          type: 'contains',
          weight: 0.9,
        });
      }

      // Rule 3: Summary references source chunk ID -> summarizes
      if (chunkA.type === 'summary') {
        for (const chunkB of chunks) {
          if (chunkA.id === chunkB.id) continue;
          if (chunkA.text.includes(chunkB.id)) {
            links.push({
              fromId: chunkA.id,
              toId: chunkB.id,
              type: 'summarizes',
              weight: 0.8,
            });
          }
        }
      }

      // Rule 4: Constraint mentions path that matches another chunk -> overrides
      if (chunkA.type === 'constraint') {
        for (const chunkB of chunks) {
          if (chunkA.id === chunkB.id) continue;
          if (chunkB.path && chunkA.text.includes(chunkB.path)) {
            links.push({
              fromId: chunkA.id,
              toId: chunkB.id,
              type: 'overrides',
              weight: 0.6,
            });
          }
        }
      }
    }

    // Deduplicate
    const seen = new Set<string>();
    return links.filter((link) => {
      const key = `${link.fromId}:${link.toId}:${link.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
