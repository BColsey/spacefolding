import { randomUUID } from 'node:crypto';
import type {
  ChunkType,
  CompressionResult,
  ContextChunk,
  ContextFilter,
  DependencyLink,
  RoutingDecision,
  ScoreResult,
  TaskDescription,
} from '../types/index.js';
import { SQLiteRepository } from '../storage/repository.js';
import { ContextScorer } from '../core/scorer.js';
import { ContextRouter } from '../core/router.js';
import { ContextIngester } from '../core/ingester.js';
import type { CompressionProvider } from '../types/index.js';
import type { DependencyAnalyzer } from '../types/index.js';

export class PipelineOrchestrator {
  constructor(
    private storage: SQLiteRepository,
    private scorer: ContextScorer,
    private router: ContextRouter,
    private compressionProvider: CompressionProvider,
    private dependencyAnalyzer: DependencyAnalyzer,
    private ingester: ContextIngester
  ) {}

  /** Run the full pipeline: score, route, compress, persist */
  async processContext(
    task: TaskDescription,
    newChunks?: ContextChunk[]
  ): Promise<ScoreResult> {
    if (newChunks) {
      for (const chunk of newChunks) {
        this.storage.storeChunk(chunk);
      }
    }

    const allChunks = this.storage.getAllChunks();
    if (allChunks.length === 0) {
      return { hot: [], warm: [], cold: [], scores: {}, reasons: {} };
    }

    const dependencies = this.dependencyAnalyzer.analyze(allChunks);
    for (const dep of dependencies) {
      this.storage.storeDependency(dep);
    }

    const { scores, reasons } = await this.scorer.scoreChunks(
      task,
      allChunks,
      dependencies
    );

    const result = this.router.route(
      scores,
      reasons,
      allChunks,
      dependencies,
      (task as TaskDescription & { maxTokens?: number }).maxTokens
    );

    const warmChunks = allChunks.filter((chunk) => result.warm.includes(chunk.id));
    if (warmChunks.length > 0) {
      const compression = await this.compressChunks(task, warmChunks);
      this.storage.storeCompression({
        id: randomUUID(),
        taskText: task.text,
        ...compression,
      });
    }

    for (const chunk of allChunks) {
      const tier = result.hot.includes(chunk.id)
        ? 'hot'
        : result.warm.includes(chunk.id)
          ? 'warm'
          : 'cold';
      this.storage.storeRoutingDecision(
        chunk.id,
        tier,
        scores[chunk.id] ?? 0,
        result.reasons[chunk.id] ?? [],
        task.text
      );
    }

    return result;
  }

  /** Convenience: ingest text and run pipeline */
  async ingestAndProcess(
    source: string,
    text: string,
    task: TaskDescription,
    type?: string
  ): Promise<{ chunk: ContextChunk; result: ScoreResult }> {
    const chunk = this.ingester.ingestText(source, text, type as ContextChunk['type']);
    const result = await this.processContext(task, [chunk]);
    return { chunk, result };
  }

  /** Retrieve chunks relevant to a task from warm/cold storage */
  async getRelevantMemory(
    task: TaskDescription,
    filters?: ContextFilter
  ): Promise<{ chunks: ContextChunk[]; explanations: string[] }> {
    const queryFilter: ContextFilter = filters ?? {};
    const chunks = this.storage.queryChunks(queryFilter);

    if (chunks.length === 0) {
      return { chunks: [], explanations: [] };
    }

    const { scores, reasons } = await this.scorer.scoreChunks(task, chunks);
    const sorted = [...chunks].sort(
      (a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0)
    );

    const topChunks = sorted.slice(0, 10);
    const explanations = topChunks.map(
      (chunk) =>
        `chunk ${chunk.id.slice(0, 8)} (score: ${(scores[chunk.id] ?? 0).toFixed(3)}, type: ${chunk.type}): ${(reasons[chunk.id] ?? []).join(', ')}`
    );

    return { chunks: topChunks, explanations };
  }

  /** Explain routing decisions for a task */
  async explainRouting(
    task: TaskDescription,
    chunkId?: string
  ): Promise<{ routing: RoutingDecision[]; summary: string }> {
    const allChunks = chunkId
      ? [this.storage.getChunk(chunkId)].filter(Boolean) as ContextChunk[]
      : this.storage.getAllChunks();

    if (allChunks.length === 0) {
      return {
        routing: [],
        summary: 'No chunks found' + (chunkId ? ` with id ${chunkId}` : ''),
      };
    }

    const dependencies = this.dependencyAnalyzer.analyze(allChunks);
    const { scores, reasons } = await this.scorer.scoreChunks(
      task,
      allChunks,
      dependencies
    );
    const result = this.router.route(scores, reasons, allChunks, dependencies);

    const routing: RoutingDecision[] = allChunks.map((chunk) => ({
      chunkId: chunk.id,
      tier: (result.hot.includes(chunk.id)
        ? 'hot'
        : result.warm.includes(chunk.id)
          ? 'warm'
          : 'cold') as RoutingDecision['tier'],
      score: scores[chunk.id] ?? 0,
      reasons: result.reasons[chunk.id] ?? [],
    }));

    const hotCount = result.hot.length;
    const warmCount = result.warm.length;
    const coldCount = result.cold.length;
    const summary = `For task "${task.text}": ${hotCount} hot, ${warmCount} warm, ${coldCount} cold chunks`;

    return { routing, summary };
  }

  /** Ingest a single context item and store it */
  ingest(
    source: string,
    text: string,
    type?: string,
    path?: string,
    language?: string
  ): ContextChunk {
    const chunk =
      path !== undefined
        ? this.ingester.ingestFile(path, text, language, type as ChunkType | undefined)
        : this.ingester.ingestText(source, text, type as ContextChunk['type']);
    this.storage.storeChunk(chunk);
    return chunk;
  }

  getAllChunks(): ContextChunk[] {
    return this.storage.getAllChunks();
  }

  async compressChunks(
    task: TaskDescription,
    chunks: ContextChunk[]
  ): Promise<CompressionResult> {
    return this.compressionProvider.compress(task, chunks);
  }

  close(): void {
    this.storage.close();
  }

  /** Get dependencies for a chunk */
  getDependencies(chunkId: string): DependencyLink[] {
    return this.storage.getDependencies(chunkId);
  }

  /** Add dependency links */
  addDependencies(links: DependencyLink[]): void {
    for (const link of links) {
      this.storage.storeDependency(link);
    }
  }

  removeDependencies(links: DependencyLink[]): void {
    for (const link of links) {
      this.storage.removeDependency(link.fromId, link.toId, link.type);
    }
  }
}
