import type { EmbeddingProvider } from '../types/index.js';
import { pipeline, env } from '@huggingface/transformers';

// Configure local model caching
env.allowLocalModels = true;
env.localModelPath = process.env.MODEL_PATH ?? './data/models';
env.useBrowserCache = false;

type EmbeddingPipeline = Awaited<ReturnType<typeof pipeline<'feature-extraction'>>>;

export class LocalEmbeddingProvider implements EmbeddingProvider {
  private pipe: EmbeddingPipeline | null = null;
  private loading: Promise<EmbeddingPipeline> | null = null;

  constructor(private modelId: string = 'Xenova/all-MiniLM-L6-v2') {}

  private async getPipeline(): Promise<EmbeddingPipeline> {
    if (this.pipe) return this.pipe;
    if (this.loading) return this.loading;

    this.loading = pipeline('feature-extraction', this.modelId, {
      dtype: 'fp32',
      progress_callback: (progress: { status: string; progress?: number; file?: string }) => {
        if (progress.status === 'progress' && progress.progress !== undefined) {
          process.stderr?.write?.(
            `\rDownloading model ${this.modelId}: ${progress.file ?? ''} ${Math.round(progress.progress)}%`
          );
        } else if (progress.status === 'done') {
          process.stderr?.write?.('\n');
        }
      },
    });

    this.pipe = await this.loading;
    return this.pipe;
  }

  async embed(text: string): Promise<number[]> {
    const pipe = await this.getPipeline();
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data as Float32Array);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    // Process sequentially to avoid memory pressure on large batches
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }
}

/** Pre-download a model to the local cache */
export async function downloadModel(modelId: string = 'Xenova/all-MiniLM-L6-v2'): Promise<void> {
  console.log(`Downloading model: ${modelId}`);
  console.log(`Cache path: ${env.localModelPath}`);

  const pipe = await pipeline('feature-extraction', modelId, {
    dtype: 'fp32',
    progress_callback: (progress: { status: string; progress?: number; file?: string }) => {
      if (progress.status === 'progress' && progress.progress !== undefined) {
        process.stderr?.write?.(
          `\r  ${progress.file ?? 'model'}: ${Math.round(progress.progress)}%`
        );
      } else if (progress.status === 'done') {
        process.stderr?.write?.(` ✓\n`);
      } else if (progress.status === 'ready') {
        console.log(`  Model loaded: ${modelId}`);
      }
    },
  });

  // Run a test embedding to verify it works
  const testOutput = await pipe('test', { pooling: 'mean', normalize: true });
  console.log(`  Embedding dimensions: ${testOutput.dims.at(-1)}`);
  console.log(`  Model ready: ${modelId}`);
}
