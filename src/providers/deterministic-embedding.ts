import type { EmbeddingProvider } from '../types/index.js';

const DIMENSIONS = 384;

/** Simple hash that maps a string to a repeatable number */
function hashString(str: string, seed: number): number {
  let h = seed;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return h;
}

/** Normalize text for embedding: lowercase, strip punctuation */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

/** Compute cosine similarity between two vectors */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    const normalized = normalize(text);
    const vector: number[] = [];
    for (let i = 0; i < DIMENSIONS; i++) {
      const hash = hashString(normalized, i * 7919 + 1);
      vector.push(hash / 2147483647); // normalize int32 to ~(-1,1)
    }
    // Normalize to unit vector
    const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    return norm === 0 ? vector : vector.map((v) => v / norm);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
