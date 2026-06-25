import type { RerankerProvider } from '../types/index.js';
import { DeterministicRerankerProvider } from './deterministic-reranker.js';

/**
 * transformers.js text-classification pipeline type. Typed loosely as a
 * callable returning an awaitable so the cross-encoder pair-scoring call
 * (`pipe([query, doc])`) compiles without forcing the full union of pipeline
 * return shapes. At runtime this is a TextClassificationPipeline.
 */
type CrossEncoderPipeline = ((
  inputs: [string, string]
) => Promise<unknown>) & {
  // Structural marker kept for clarity; the runtime object has many more props.
};

export interface CrossEncoderRerankerOptions {
  /** HuggingFace model id for the cross-encoder (ONNX, transformers.js). */
  modelId?: string;
  /** When true (or when the model cannot load), fall back to the deterministic
   * jaccard reranker — keeps tests/CI offline and deterministic. */
  useDeterministicFallback?: boolean;
  /** Max candidates to return after scoring. */
  topK?: number;
  /** Truncate each document to roughly this many characters before scoring
   * (token-budget guard; cross-encoders are length-sensitive and slow). */
  maxDocChars?: number;
}

export class CrossEncoderRerankerProvider implements RerankerProvider {
  private readonly modelId: string;
  private readonly topK: number;
  private readonly maxDocChars: number;
  private readonly fallback: DeterministicRerankerProvider;
  /** Set lazily on first successful model load; null while loading, false if
   * loading failed (then permanently uses fallback). */
  private modelFailed = false;
  private pipe: CrossEncoderPipeline | null = null;
  private loading: Promise<CrossEncoderPipeline> | null = null;

  constructor(opts: CrossEncoderRerankerOptions = {}) {
    this.modelId = opts.modelId ?? 'Xenova/bge-reranker-v2-m3';
    this.topK = opts.topK ?? 20;
    this.maxDocChars = opts.maxDocChars ?? 2048;
    this.fallback = new DeterministicRerankerProvider();
    if (opts.useDeterministicFallback) this.modelFailed = true;
  }

  async rerank(
    query: string,
    documents: string[]
  ): Promise<{ index: number; score: number; reason: string }[]> {
    if (this.modelFailed) {
      return this.fallback.rerank(query, documents).then((r) => r.slice(0, this.topK));
    }
    try {
      const pipe = await this.getPipeline();
      const pairs = documents.map((doc) => [query, doc.slice(0, this.maxDocChars)] as [string, string]);
      const scored: { index: number; score: number; reason: string }[] = [];
      for (let i = 0; i < pairs.length; i++) {
        const output = await pipe(pairs[i]);
        const prob = extractRelevanceProb(output);
        scored.push({ index: i, score: prob, reason: 'cross-encoder relevance' });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, this.topK);
    } catch (err) {
      // Model unavailable (no network / not cached) — permanently fall back so
      // subsequent calls stay cheap and offline-safe.
      this.modelFailed = true;
      return this.fallback.rerank(query, documents).then((r) => r.slice(0, this.topK));
    }
  }

  private async getPipeline() {
    if (this.pipe) return this.pipe;
    if (this.loading) return this.loading;
    const { pipeline, env } = await import('@huggingface/transformers');
    const { ensureModelCacheDir } = await import('./model-cache.js');
    env.allowLocalModels = true;
    env.localModelPath = ensureModelCacheDir();
    env.useBrowserCache = false;
    this.loading = pipeline('text-classification', this.modelId, {
      dtype: 'fp32',
      progress_callback: (p: { status: string; progress?: number; file?: string }) => {
        if (p.status === 'progress' && p.progress !== undefined) {
          process.stderr?.write?.(`\rDownloading reranker ${this.modelId}: ${p.file ?? ''} ${Math.round(p.progress)}%`);
        } else if (p.status === 'done') {
          process.stderr?.write?.('\n');
        }
      },
    }) as Promise<CrossEncoderPipeline>;
    this.pipe = await this.loading;
    return this.pipe;
  }
}

function extractRelevanceProb(output: unknown): number {
  // transformers.js text-classification returns { label, score }[] or a Tensor.
  if (Array.isArray(output) && typeof output[0]?.score === 'number') {
    return output[0].score;
  }
  if (output && typeof output === 'object' && 'data' in output) {
    const data = (output as { data: Float32Array | number[] }).data;
    return Array.isArray(data) ? data[0] ?? 0 : data[0] ?? 0;
  }
  return 0;
}
