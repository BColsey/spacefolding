import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type {
  ChunkType,
  CompressionResult,
  ContextChunk,
  ContextFilter,
  DependencyLink,
  EmbeddingProvider,
  RoutingDecision,
  ScoreResult,
  TaskDescription,
} from '../types/index.js';
import { SQLiteRepository } from '../storage/repository.js';
import { ContextScorer } from '../core/scorer.js';
import { ContextRouter } from '../core/router.js';
import { ContextIngester } from '../core/ingester.js';
import type { IngestResult } from '../core/ingester.js';
import type { CompressionProvider } from '../types/index.js';
import type { DependencyAnalyzer } from '../types/index.js';
import { HybridRetriever } from '../core/retriever.js';
import type { RetrievalOptions, RetrievalResult } from '../core/retriever.js';
import { fillBudget, compressOmitted } from '../core/budget.js';
import { planQuery } from '../core/query-planner.js';

export class PipelineOrchestrator {
  private retriever: HybridRetriever;
  private embeddingModel: string;

  constructor(
    private storage: SQLiteRepository,
    private scorer: ContextScorer,
    private router: ContextRouter,
    private compressionProvider: CompressionProvider,
    private dependencyAnalyzer: DependencyAnalyzer,
    private ingester: ContextIngester,
    private embeddingProvider?: EmbeddingProvider
  ) {
    this.embeddingModel = process.env.EMBEDDING_MODEL ?? 'deterministic';
    this.retriever = new HybridRetriever(storage, embeddingProvider ?? {
      embed: async () => [],
      embedBatch: async () => [],
    });
  }

  /** Run the full pipeline: score, route, compress, persist */
  async processContext(
    task: TaskDescription,
    newChunks?: ContextChunk[]
  ): Promise<ScoreResult> {
    if (newChunks) {
      for (const chunk of newChunks) {
        await this.storeChunkWithEmbedding(chunk);
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
    const result = this.ingester.ingestText(source, text, type as ContextChunk['type']);
    const chunk = result.split ? result.split.parent : result.primary;
    const chunks = result.split
      ? [result.split.parent, ...result.split.children]
      : [result.primary];
    const pipelineResult = await this.processContext(task, chunks);
    return { chunk, result: pipelineResult };
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

  /** Ingest a single context item, auto-splitting and storing embeddings */
  async ingest(
    source: string,
    text: string,
    type?: string,
    path?: string,
    language?: string
  ): Promise<ContextChunk> {
    // Deduplication: check if we've already ingested this exact content
    const contentHash = createHash('sha256').update(text).digest('hex').slice(0, 16);
    const existing = this.storage.findChunkByMetadata('contentHash', contentHash);
    if (existing) return existing;

    const result: IngestResult =
      path !== undefined
        ? this.ingester.ingestFile(path, text, language, type as ChunkType | undefined)
        : this.ingester.ingestText(source, text, type as ContextChunk['type']);

    const chunk = result.primary;
    chunk.metadata.contentHash = contentHash;

    // If split occurred, store parent (metadata-only) + children (with embeddings)
    if (result.split) {
      result.split.parent.metadata.contentHash = contentHash;
      this.storage.storeChunk(result.split.parent); // No embedding for parent
      for (const child of result.split.children) {
        child.metadata.contentHash = createHash('sha256').update(child.text).digest('hex').slice(0, 16);
        await this.storeChunkWithEmbedding(child);
        this.storage.storeDependency({
          fromId: result.split.parent.id,
          toId: child.id,
          type: 'contains',
          weight: 1.0,
        });
      }
      return result.split.parent;
    }

    await this.storeChunkWithEmbedding(chunk);
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

  /** Store a chunk and await its embedding */
  private async storeChunkWithEmbedding(chunk: ContextChunk): Promise<void> {
    this.storage.storeChunk(chunk);
    if (this.embeddingProvider) {
      try {
        const embedding = await this.embeddingProvider.embed(chunk.text);
        if (embedding.length > 0) {
          this.storage.storeEmbedding(chunk.id, embedding, this.embeddingModel);
        }
      } catch {
        // Embedding failure is non-fatal — chunk is still stored
      }
    }
  }

  /** Retrieve context for a query using hybrid search + budget control */
  async retrieve(
    query: string,
    maxTokens?: number,
    options?: RetrievalOptions
  ): Promise<{
    chunks: ContextChunk[];
    tiers: Map<string, import('../types/index.js').ContextTier>;
    totalTokens: number;
    budget: number;
    utilization: number;
    omitted: { chunkId: string; tokensEstimate: number; reason: string }[];
    compressed: { chunkId: string; summary: string; tokensEstimate: number }[];
    plan: ReturnType<typeof planQuery>;
    retrieval: RetrievalResult[];
  }> {
    const plan = planQuery(query);
    const budget = maxTokens ?? Math.floor(200_000 * plan.tokenBudgetRatio);
    const retrieval = await this.retriever.retrieve(query, {
      ...options,
      topK: options?.topK ?? 15,
      maxHops: options?.maxHops ?? plan.maxHops,
      strategy: options?.strategy ?? plan.strategy,
    });

    // Load chunks for retrieved IDs
    const chunkMap = new Map<string, ContextChunk>();
    for (const result of retrieval) {
      const chunk = this.storage.getChunk(result.chunkId);
      if (chunk) chunkMap.set(result.chunkId, chunk);
    }

    // Get current hot chunk IDs from recent routing history
    const hotIds = new Set<string>();
    for (const result of retrieval.slice(0, retrieval.length)) {
      // Check if this chunk was recently routed to hot tier
      const chunk = chunkMap.get(result.chunkId);
      if (chunk) {
        const deps = this.storage.getDependencies(chunk.id);
        // A chunk with many inbound dependency links is likely important
        if (deps.length >= 3) hotIds.add(chunk.id);
      }
    }

    const budgetResult = fillBudget(retrieval, chunkMap, budget, {
      hotChunkIds: hotIds,
      collapseSiblings: true,
    });

    // Compress omitted chunks that could fit as summaries
    if (budgetResult.omitted.length > 0) {
      await compressOmitted(budgetResult, retrieval, chunkMap, {
        estimateCompressed: (tokens) => Math.max(50, Math.floor(tokens * 0.1)),
        compress: async (chunkId) => {
          const chunk = chunkMap.get(chunkId);
          if (!chunk) return null;
          try {
            const result = await this.compressionProvider.compress(
              { text: query },
              [chunk]
            );
            const tokensEstimate = Math.ceil(result.summary.split(/\s+/).length * 1.3);
            return { summary: result.summary, tokensEstimate };
          } catch {
            return null;
          }
        },
        maxCompress: 5,
      });
    }

    return {
      chunks: budgetResult.selected,
      tiers: budgetResult.tiers,
      totalTokens: budgetResult.totalTokens,
      budget: budgetResult.budget,
      utilization: budgetResult.utilization,
      omitted: budgetResult.omitted,
      compressed: budgetResult.compressed,
      plan,
      retrieval,
    };
  }
}
