import type { RerankerProvider } from '../types/index.js';

export class DeterministicRerankerProvider implements RerankerProvider {
  async rerank(
    query: string,
    documents: string[]
  ): Promise<{ index: number; score: number; reason: string }[]> {
    const queryWords = new Set(
      query.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
    );

    const results = documents.map((doc, index) => {
      const docWords = doc.toLowerCase().split(/\s+/);
      let matchCount = 0;
      for (const word of docWords) {
        if (queryWords.has(word)) matchCount++;
      }
      const score = queryWords.size > 0 ? matchCount / queryWords.size : 0;
      let reason = 'no keyword overlap';
      if (score >= 0.5) reason = 'direct keyword match';
      else if (score > 0) reason = 'partial keyword match';
      return { index, score, reason };
    });

    results.sort((a, b) => b.score - a.score);
    return results;
  }
}
