import type { EmbeddingProvider } from '../types/index.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * GPU-accelerated embedding provider using a Python subprocess with CUDA.
 *
 * Uses sentence-transformers on GPU for high-quality, fast embeddings.
 * Falls back to CPU if CUDA is unavailable.
 *
 * Communication: JSON-RPC over stdin/stdout with the Python embedder.
 * Each request gets a unique ID; responses are matched by ID.
 *
 * Environment variables:
 *   GPU_EMBEDDING_MODEL  - Model name (default: Alibaba-NLP/gte-modernbert-base)
 *   GPU_EMBEDDING_DEVICE - Device: cuda, cpu (default: cuda)
 *   PYTHON_PATH          - Python executable (default: python3)
 */
export class GpuEmbeddingProvider implements EmbeddingProvider {
  private process: ChildProcess | null = null;
  private ready = false;
  private dim = 0;
  private modelName = '';
  private deviceName = '';
  private pending = new Map<number, {
    resolve: (value: number[][]) => void;
    reject: (error: Error) => void;
  }>();
  private nextId = 0;
  private initPromise: Promise<void> | null = null;

  constructor(
    private modelId: string = process.env.GPU_EMBEDDING_MODEL ?? 'Alibaba-NLP/gte-modernbert-base',
    private device: string = process.env.GPU_EMBEDDING_DEVICE ?? 'cuda',
    private pythonPath: string = process.env.PYTHON_PATH ?? 'python3',
  ) {}

  private async ensureReady(): Promise<void> {
    if (this.ready && this.process) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.launch();
    return this.initPromise;
  }

  private launch(): Promise<void> {
    return new Promise((resolve, reject) => {
      const scriptPath = new URL('../../scripts/gpu-embedder.py', import.meta.url).pathname;

      this.process = spawn(this.pythonPath, [
        scriptPath,
        '--model', this.modelId,
        '--device', this.device,
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });

      this.process.on('error', (err) => {
        reject(new Error(`GPU embedder spawn failed: ${err.message}`));
      });

      const rl = createInterface({ input: this.process.stdout! });
      rl.on('line', (line) => {
        try {
          const msg = JSON.parse(line);

          // Ready signal
          if (msg.status === 'ready') {
            this.ready = true;
            this.modelName = msg.model;
            this.deviceName = msg.device;
            this.dim = msg.dim;
            resolve();
            return;
          }

          // Response to an embedding request
          const reqId = msg.id;
          const handler = this.pending.get(reqId);
          if (!handler) return;

          this.pending.delete(reqId);

          if (msg.error) {
            handler.reject(new Error(msg.error));
          } else {
            handler.resolve(msg.embeddings as number[][]);
          }
        } catch {
          // Ignore malformed lines
        }
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text) process.stderr?.write?.(`[gpu-embedder] ${text}\n`);
      });

      this.process.on('exit', (code) => {
        this.ready = false;
        this.process = null;
        // Reject all pending requests
        for (const [id, handler] of this.pending) {
          this.pending.delete(id);
          handler.reject(new Error(`GPU embedder exited (code ${code})`));
        }
        if (!this.ready) {
          reject(new Error(`GPU embedder exited before ready (code ${code})`));
        }
      });

      // Timeout: 120s for first-time model download
      setTimeout(() => {
        if (!this.ready) {
          this.process?.kill();
          reject(new Error('GPU embedder startup timed out (120s). Model download may still be in progress.'));
        }
      }, 120_000);
    });
  }

  async embed(text: string): Promise<number[]> {
    const batch = await this.embedBatch([text]);
    return batch[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.ensureReady();

    return new Promise((resolve, reject) => {
      const id = this.nextId++;

      // Timeout for individual requests (5 minutes for large batches)
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Embedding request ${id} timed out`));
      }, 300_000);

      this.pending.set(id, {
        resolve: (embeddings) => {
          clearTimeout(timeout);
          resolve(embeddings);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      const msg = JSON.stringify({ id, texts });
      this.process!.stdin!.write(msg + '\n');
    });
  }

  close(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
      this.ready = false;
    }
  }
}
