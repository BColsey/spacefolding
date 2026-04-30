/**
 * LLMLingua Compression Provider
 *
 * Token-level compression via LLMLingua Python subprocess.
 * Similar to GpuEmbeddingProvider — JSON-RPC over stdin/stdout.
 *
 * Usage: Set COMPRESSION_PROVIDER=llmlingua
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { CompressionProvider, CompressionResult, TaskDescription, ContextChunk } from '../types/index.js';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}

export class LlmLinguaCompressionProvider implements CompressionProvider {
  private process: ChildProcess | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private buffer = '';
  private ready = false;

  constructor(
    private model = process.env.LLMLINGUA_MODEL ?? 'microsoft/llmlingua-2-xlm-roberta-large-meetingbank',
    private pythonPath = process.env.PYTHON_PATH ?? 'python3',
    private compressionRate = parseFloat(process.env.LLMLINGUA_RATE ?? '0.5'),
  ) {}

  private ensureProcess(): Promise<void> {
    if (this.process && this.ready) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('LLMLingua compressor timed out waiting for ready signal'));
      }, 60_000);

      this.process = spawn(this.pythonPath, [
        'scripts/llmlingua-compressor.py',
        '--model', this.model,
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      this.process.stdout!.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            const pending = this.pending.get(msg.id);
            if (pending) {
              this.pending.delete(msg.id);
              if (msg.error) pending.reject(new Error(msg.error));
              else pending.resolve(msg.result);
            }
          } catch { /* ignore partial JSON */ }
        }
      });

      this.process.stderr!.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text.includes('ready')) {
          this.ready = true;
          clearTimeout(timeout);
          resolve();
        }
      });

      this.process.on('exit', (code) => {
        if (!this.ready) {
          clearTimeout(timeout);
          reject(new Error(`LLMLingua compressor exited before ready (code ${code})`));
        }
      });
    });
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<any> {
    await this.ensureProcess();
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process!.stdin!.write(JSON.stringify({ id, method, params }) + '\n');

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  async compress(task: TaskDescription, chunks: ContextChunk[]): Promise<CompressionResult> {
    const context = chunks.map((c) => c.text).join('\n\n');

    const result = await this.rpc('compress', {
      context,
      rate: this.compressionRate,
    });

    return {
      summary: result.compressed,
      retainedFacts: [],
      retainedConstraints: [],
      sourceChunkIds: chunks.map((c) => c.id),
    };
  }

  close(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.ready = false;
    }
  }
}
