import type { TokenEstimator } from '../types/index.js';

export class DeterministicTokenEstimator implements TokenEstimator {
  estimate(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  estimateBatch(texts: string[]): number[] {
    return texts.map((t) => this.estimate(t));
  }
}
