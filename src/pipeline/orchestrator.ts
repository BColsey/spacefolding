import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
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
import {
  budgetForSelectedCandidates,
  createRetrievalSelectionPolicy,
  selectRetrievalCandidates,
} from '../core/retrieval-policy.js';
import { DeterministicRerankerProvider } from '../providers/deterministic-reranker.js';
import { StructuralIndexer, isSupportedCodeLanguage } from '../providers/structural-indexer.js';

export interface ProjectIngestOptions {
  includeDocs?: boolean;
  includeTests?: boolean;
  includeBenchmarks?: boolean;
}

export interface ProjectIngestResult {
  files: number;
  chunks: string[];
  skipped: number;
  codeFiles: number;
  projectContextFiles: number;
}

export class PipelineOrchestrator {
  private retriever: HybridRetriever;
  private embeddingModel: string;
  private structuralIndexer: StructuralIndexer;

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
    this.structuralIndexer = new StructuralIndexer();
    this.retriever = new HybridRetriever(storage, embeddingProvider ?? {
      embed: async () => [],
      embedBatch: async () => [],
    }, new DeterministicRerankerProvider());
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

    // For large chunk counts, use vector search as a first-pass filter
    // instead of brute-force scoring everything
    let candidateChunks = allChunks;
    if (allChunks.length > 50) {
      const retrieval = await this.retriever.retrieve(task.text, {
        topK: Math.min(allChunks.length, 50),
        strategy: 'vector',
        maxHops: 0,
      });
      const candidateIds = new Set(retrieval.map(r => r.chunkId));
      candidateChunks = allChunks.filter(c => candidateIds.has(c.id));
      // Always include newly ingested chunks
      if (newChunks) {
        for (const nc of newChunks) {
          if (!candidateIds.has(nc.id)) candidateChunks.push(nc);
        }
      }
    }

    const dependencies = this.dependencyAnalyzer.analyze(candidateChunks);
    for (const dep of dependencies) {
      this.storage.storeDependency(dep);
    }

    const { scores, reasons } = await this.scorer.scoreChunks(
      task,
      candidateChunks,
      dependencies
    );

    const result = this.router.route(
      scores,
      reasons,
      candidateChunks,
      dependencies,
      (task as TaskDescription & { maxTokens?: number }).maxTokens
    );

    const warmChunks = candidateChunks.filter((chunk) => result.warm.includes(chunk.id));
    if (warmChunks.length > 0) {
      const compression = await this.compressChunks(task, warmChunks);
      this.storage.storeCompression({
        id: randomUUID(),
        taskText: task.text,
        ...compression,
      });
    }

    for (const chunk of candidateChunks) {
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
    // Use retrieval instead of brute-force scoring all chunks
    const result = await this.retrieve(task.text, undefined, {
      topK: 10,
      strategy: undefined,
      maxHops: 0,
    });

    let chunks = result.chunks;

    // Apply filters if provided
    if (filters) {
      if (filters.type) chunks = chunks.filter(c => c.type === filters.type);
      if (filters.source) chunks = chunks.filter(c => c.source === filters.source);
      if (filters.path) chunks = chunks.filter(c => c.path?.includes(filters.path!));
      if (filters.textContains) chunks = chunks.filter(c => c.text.includes(filters.textContains!));
      if (filters.tier) chunks = chunks.filter(c => result.tiers.get(c.id) === filters.tier);
    }

    const explanations = chunks.map(
      (chunk) => {
        const tier = result.tiers.get(chunk.id) ?? 'warm';
        return `chunk ${chunk.id.slice(0, 8)} (${tier}, type: ${chunk.type}, ~${chunk.tokensEstimate} tokens): ${chunk.text.slice(0, 100)}`;
      }
    );

    return { chunks, explanations };
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
    // Deduplication: file content is scoped by path so identical files at
    // different paths remain distinct chunks.
    const contentHash = createHash('sha256').update(text).digest('hex').slice(0, 16);
    const existing = this.storage.findChunkByContentHash(contentHash, path);
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
    this.enforceMaxChunks();
    return chunk;
  }

  getAllChunks(): ContextChunk[] {
    return this.storage.getAllChunks();
  }

  /** Ingest all files in a directory tree */
  async ingestDirectory(
    dirPath: string,
    type?: string
  ): Promise<{ files: number; chunks: string[]; skipped: number }> {
    const files = walkDir(dirPath);
    const chunks: string[] = [];
    let skipped = 0;

    for (const filePath of files) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const chunk = await this.ingest('file', content, type, filePath);
        chunks.push(chunk.id);
        this.enforceMaxChunks();
      } catch {
        skipped++;
      }
    }

    return { files: files.length, chunks, skipped };
  }

  /** Ingest a project with code plus selected project-level context files. */
  async ingestProject(
    dirPath: string,
    options: ProjectIngestOptions = {}
  ): Promise<ProjectIngestResult> {
    const resolvedOptions = {
      includeDocs: options.includeDocs ?? true,
      includeTests: options.includeTests ?? false,
      includeBenchmarks: options.includeBenchmarks ?? false,
    };
    const files = walkProjectFiles(dirPath, resolvedOptions);
    const chunks: string[] = [];
    let skipped = 0;
    let codeFiles = 0;
    let projectContextFiles = 0;

    for (const filePath of files) {
      const relativePath = normalizePath(relative(dirPath, filePath));
      const contextKind = getProjectContextKind(relativePath, resolvedOptions);
      const isCode = isCodePath(relativePath);

      try {
        const content = readFileSync(filePath, 'utf-8');

        if (contextKind === 'agent-instruction') {
          projectContextFiles++;
          for (const section of segmentAgentInstructions(content)) {
            const chunk = await this.ingest('file', section.text, section.type, relativePath);
            this.annotateChunkTree(chunk, {
              projectContext: true,
              projectContextKind: contextKind,
              instructionCategory: section.category,
              projectRoot: dirPath,
            });
            chunks.push(chunk.id);
          }
          continue;
        }

        const chunk = await this.ingest(
          'file',
          content,
          contextKind ? 'reference' : undefined,
          relativePath
        );
        if (contextKind) {
          projectContextFiles++;
          this.annotateChunkTree(chunk, {
            projectContext: true,
            projectContextKind: contextKind,
            projectRoot: dirPath,
          });
        } else if (isCode) {
          codeFiles++;
        }
        chunks.push(chunk.id);
        this.enforceMaxChunks();
      } catch {
        skipped++;
      }
    }

    return { files: files.length, chunks, skipped, codeFiles, projectContextFiles };
  }

  /** Get storage stats: chunk counts, token totals, per-file breakdown */
  getStats(): {
    totalChunks: number;
    totalTokensEstimate: number;
    files: Array<{ path: string; chunkCount: number; tokensEstimate: number }>;
    oldestTimestamp: number | null;
    newestTimestamp: number | null;
  } {
    const allChunks = this.storage.getAllChunks();
    if (allChunks.length === 0) {
      return { totalChunks: 0, totalTokensEstimate: 0, files: [], oldestTimestamp: null, newestTimestamp: null };
    }

    const fileMap = new Map<string, { chunkCount: number; tokensEstimate: number }>();
    let totalTokens = 0;
    let oldest = Infinity;
    let newest = 0;

    for (const chunk of allChunks) {
      const key = chunk.path ?? chunk.source;
      const entry = fileMap.get(key) ?? { chunkCount: 0, tokensEstimate: 0 };
      entry.chunkCount++;
      entry.tokensEstimate += chunk.tokensEstimate;
      fileMap.set(key, entry);
      totalTokens += chunk.tokensEstimate;
      if (chunk.timestamp < oldest) oldest = chunk.timestamp;
      if (chunk.timestamp > newest) newest = chunk.timestamp;
    }

    const files = Array.from(fileMap.entries())
      .map(([path, { chunkCount, tokensEstimate }]) => ({ path, chunkCount, tokensEstimate }))
      .sort((a, b) => b.tokensEstimate - a.tokensEstimate);

    return {
      totalChunks: allChunks.length,
      totalTokensEstimate: totalTokens,
      files,
      oldestTimestamp: oldest === Infinity ? null : oldest,
      newestTimestamp: newest === 0 ? null : newest,
    };
  }

  /** Delete chunks by ID, cleaning up embeddings and dependencies */
  deleteChunks(chunkIds: string[]): number {
    let deleted = 0;
    for (const id of chunkIds) {
      this.storage.removeAllDependenciesForChunk(id);
      this.storage.deleteChunk(id);
      deleted++;
    }
    return deleted;
  }

  /** Enforce max chunk count by evicting oldest non-hot chunks */
  private enforceMaxChunks(): void {
    const maxChunks = parseInt(process.env.MAX_CHUNKS ?? '10000', 10);
    const current = this.storage.getChunkCount();
    if (current <= maxChunks) return;

    const toEvict = current - maxChunks;
    const allChunks = this.storage.getAllChunks();
    // Sort by timestamp ascending (oldest first), skip chunks with dependency links (likely important)
    const candidates = allChunks
      .filter(c => this.storage.getDependencies(c.id).length === 0)
      .sort((a, b) => a.timestamp - b.timestamp);

    let evicted = 0;
    for (const chunk of candidates) {
      if (evicted >= toEvict) break;
      this.storage.removeAllDependenciesForChunk(chunk.id);
      this.storage.deleteChunk(chunk.id);
      evicted++;
    }
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
    await this.storeChunkStructure(chunk);
  }

  private async storeChunkStructure(chunk: ContextChunk): Promise<void> {
    if (!chunk.path || !isSupportedCodeLanguage(chunk.language)) {
      this.storage.deleteCodeStructure(chunk.id);
      return;
    }
    try {
      const extraction = await this.structuralIndexer.extract(chunk.text, chunk.language, chunk.path);
      this.storage.storeCodeStructure(
        chunk.id,
        extraction.symbols.map((symbol) => ({
          ...symbol,
          chunkId: chunk.id,
          path: chunk.path,
          language: chunk.language,
          metadata: { ...symbol.metadata, backend: extraction.backend },
        })),
        extraction.references.map((reference) => ({
          ...reference,
          chunkId: chunk.id,
          path: chunk.path,
          language: chunk.language,
          metadata: { ...reference.metadata, backend: extraction.backend },
        }))
      );
    } catch {
      this.storage.deleteCodeStructure(chunk.id);
    }
  }

  private annotateChunkTree(chunk: ContextChunk, metadata: Record<string, unknown>): void {
    const annotate = (chunkId: string) => {
      const stored = this.storage.getChunk(chunkId);
      if (!stored) return;
      stored.metadata = { ...stored.metadata, ...metadata };
      this.storage.updateChunk(stored);
    };

    annotate(chunk.id);
    for (const childId of chunk.childrenIds) annotate(childId);
  }

  /** Retrieve context for a query using search + selection policy + budget control */
  async retrieve(
    query: string,
    maxTokens?: number,
    options?: RetrievalOptions
  ): Promise<{
    chunks: ContextChunk[];
    tiers: Map<string, import('../types/index.js').ContextTier>;
    totalTokens: number;
    budget: number;
    hardBudget: number;
    targetBudget: number;
    utilization: number;
    omitted: { chunkId: string; tokensEstimate: number; reason: string }[];
    compressed: { chunkId: string; summary: string; tokensEstimate: number }[];
    plan: ReturnType<typeof planQuery>;
    retrieval: RetrievalResult[];
    selectionPolicy: ReturnType<typeof createRetrievalSelectionPolicy> & {
      effectiveBudget: number;
      selectedCandidates: number;
      droppedCandidates: number;
    };
  }> {
    const planned = planQuery(query);
    const effectiveStrategy = options?.strategy ?? (this.storage.hasCodeStructure() ? 'structural' : planned.strategy);
    const plan = { ...planned, strategy: effectiveStrategy };
    const hardBudget = maxTokens ?? Math.floor(200_000 * plan.tokenBudgetRatio);
    const requestedTopK = options?.topK ?? plan.recommendedTopK;
    const retrieval = await this.retriever.retrieve(query, {
      ...options,
      topK: requestedTopK,
      maxHops: options?.maxHops ?? plan.maxHops,
      strategy: effectiveStrategy,
    });

    // Load chunks for retrieved IDs
    const chunkMap = new Map<string, ContextChunk>();
    for (const result of retrieval) {
      const chunk = this.storage.getChunk(result.chunkId);
      if (chunk) chunkMap.set(result.chunkId, chunk);
    }

    // Get current hot chunk IDs from recent routing history. These are used
    // only as tier metadata for retrieval output; ranking order stays owned by
    // the retriever so dependency-heavy files do not jump ahead of stronger
    // lexical or structural matches.
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

    const contextLimit = options?.returnLimit ?? requestedTopK;
    const basePolicy = createRetrievalSelectionPolicy({
      mode: options?.mode,
      complexity: plan.complexity,
      hardBudget,
      requestedTopK: contextLimit,
      returnLimit: contextLimit,
    });
    const selectedCandidates = selectRetrievalCandidates(retrieval, chunkMap, basePolicy);
    const rankedForBudget = selectedCandidates.ranked;
    const effectiveBudget = budgetForSelectedCandidates(rankedForBudget, chunkMap, selectedCandidates.policy);

    const budgetResult = fillBudget(rankedForBudget, chunkMap, effectiveBudget, {
      collapseSiblings: true,
    });

    for (const chunk of budgetResult.selected) {
      if (hotIds.has(chunk.id)) budgetResult.tiers.set(chunk.id, 'hot');
    }

    // Compress omitted chunks that could fit as summaries
    if (budgetResult.omitted.length > 0) {
      await compressOmitted(budgetResult, rankedForBudget, chunkMap, {
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
      budget: hardBudget,
      hardBudget,
      targetBudget: effectiveBudget,
      utilization: hardBudget > 0 ? budgetResult.totalTokens / hardBudget : 0,
      omitted: budgetResult.omitted,
      compressed: budgetResult.compressed,
      plan,
      retrieval,
      selectionPolicy: {
        ...selectedCandidates.policy,
        targetBudget: effectiveBudget,
        effectiveBudget,
        selectedCandidates: rankedForBudget.length,
        droppedCandidates: selectedCandidates.dropped.length,
      },
    };
  }

  /** Iterative retrieval: retrieve → expand query from results → re-retrieve */
  async iterativeRetrieve(
    query: string,
    maxRounds = 2,
    maxTokens?: number,
    options?: RetrievalOptions
  ): Promise<{
    rounds: Array<{
      round: number;
      query: string;
      chunks: ContextChunk[];
      newChunkCount: number;
    }>;
    finalChunks: ContextChunk[];
    finalTiers: Map<string, import('../types/index.js').ContextTier>;
    totalTokens: number;
    budget: number;
  }> {
    const seenChunkIds = new Set<string>();
    const rounds: Array<{
      round: number;
      query: string;
      chunks: ContextChunk[];
      newChunkCount: number;
    }> = new Array();
    const allChunks: ContextChunk[] = [];
    const allTiers = new Map<string, import('../types/index.js').ContextTier>();
    let totalTokens = 0;
    const budget = maxTokens ?? 100_000;
    let currentQuery = query;

    for (let round = 0; round < maxRounds; round++) {
      const result = await this.retrieve(currentQuery, budget - totalTokens, options);

      // Filter to only new chunks
      const newChunks = result.chunks.filter(c => !seenChunkIds.has(c.id));
      const newTokens = newChunks.reduce((s, c) => s + c.tokensEstimate, 0);

      // Stop if no new chunks found
      if (newChunks.length === 0) break;

      // Track what we've seen
      for (const chunk of newChunks) {
        seenChunkIds.add(chunk.id);
        allChunks.push(chunk);
        allTiers.set(chunk.id, result.tiers.get(chunk.id) ?? 'warm');
      }
      totalTokens += newTokens;

      rounds.push({
        round,
        query: currentQuery,
        chunks: newChunks,
        newChunkCount: newChunks.length,
      });

      // Expand query for next round using keywords from retrieved chunks
      // Extract meaningful identifiers from chunk text and paths
      const expandedTerms = newChunks
        .flatMap(c => {
          const pathTerms = (c.path ?? '').split(/[/.]/).filter((s: string) => s.length > 2 && s !== 'ts' && s !== 'src');
          const codeTerms = c.text
            .split(/\s+/)
            .filter((w: string) => /^[a-zA-Z_]{4,}$/.test(w))
            .slice(0, 5);
          return [...pathTerms, ...codeTerms];
        })
        .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
        .slice(0, 10);

      currentQuery = expandedTerms.length > 0
        ? `${query} ${expandedTerms.join(' ')}`
        : query;

      // Stop if we've filled the budget
      if (totalTokens >= budget * 0.9) break;
    }

    return {
      rounds,
      finalChunks: allChunks,
      finalTiers: allTiers,
      totalTokens,
      budget,
    };
  }
}

const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.svg', '.webp', '.mp3', '.mp4', '.zip', '.gz', '.tar', '.db']);
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java']);
const PROJECT_SKIP_DIRS = new Set([
  '.cache',
  '.git',
  '.hg',
  '.next',
  '.svn',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'data',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
  'venv',
]);

function walkDir(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry !== 'node_modules' && entry !== '.git' && entry !== 'dist' && entry !== '.next' && entry !== '.cache') {
        results.push(...walkDir(fullPath));
      }
    } else {
      const ext = extname(entry);
      if (!BINARY_EXTENSIONS.has(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function walkProjectFiles(
  dir: string,
  options: Required<ProjectIngestOptions>,
  rootDir: string = dir
): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (PROJECT_SKIP_DIRS.has(entry)) continue;
      if (!options.includeBenchmarks && entry === 'benchmarks') continue;
      if (!options.includeTests && isTestPath(entry)) continue;
      results.push(...walkProjectFiles(fullPath, options, rootDir));
      continue;
    }

    const normalized = normalizePath(fullPath);
    const relativePath = normalizePath(relative(rootDir, fullPath));
    const ext = extname(entry).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) continue;
    if (!options.includeTests && isTestPath(normalized)) continue;
    if (!options.includeBenchmarks && relativePath.split('/').includes('benchmarks')) continue;

    if (isCodePath(entry) || getProjectContextKind(relativePath, options)) {
      results.push(fullPath);
    }
  }
  return results;
}

function isCodePath(filePath: string): boolean {
  return CODE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function getProjectContextKind(
  filePath: string,
  options: Required<ProjectIngestOptions>
): string | null {
  const normalized = normalizePath(filePath);
  const lower = normalized.toLowerCase();
  const base = basename(lower);

  if (isAgentInstructionPath(lower)) return 'agent-instruction';
  if (base === '.env.example' || base.endsWith('.env.example')) return 'environment';
  if (options.includeDocs && /^readme(\.[^.]+)?$/i.test(base)) return 'documentation';
  if (options.includeDocs && lower.startsWith('docs/') && base.endsWith('.md')) return 'documentation';
  if (base === 'package.json' || base === 'package-lock.json') return 'configuration';
  if (/^(tsconfig|jsconfig)(\..*)?\.json$/i.test(base)) return 'configuration';
  if (/^(vite|next|nuxt|astro|svelte|vitest|jest|eslint|prettier|biome|rollup|webpack|babel)\.config\./i.test(base)) {
    return 'configuration';
  }
  if (base === 'dockerfile' || /^docker-compose\..*ya?ml$/i.test(base) || /^compose\..*ya?ml$/i.test(base)) {
    return 'configuration';
  }

  return null;
}

function isAgentInstructionPath(lowerPath: string): boolean {
  const base = basename(lowerPath);
  return base === 'agents.md'
    || base === 'claude.md'
    || lowerPath === '.github/copilot-instructions.md'
    || lowerPath.startsWith('.cursor/rules/');
}

function segmentAgentInstructions(text: string): Array<{
  text: string;
  type: ChunkType;
  category: string;
}> {
  const sections = text
    .split(/(?=^#{1,3}\s+)/m)
    .map((section) => section.trim())
    .filter(Boolean);
  const normalizedSections = sections.length > 0 ? sections : [text.trim()].filter(Boolean);

  return normalizedSections.map((section) => ({
    text: section,
    type: isConstraintInstruction(section) ? 'constraint' : 'instruction',
    category: categorizeInstruction(section),
  }));
}

function isConstraintInstruction(text: string): boolean {
  return /\b(must|never|required|forbidden|always|only|avoid|do not|don't|should not|cannot|can't)\b/i.test(text);
}

function categorizeInstruction(text: string): string {
  const lower = text.toLowerCase();
  if (/\b(security|secret|credential|permission|auth|sandbox|safe|privacy)\b/.test(lower)) return 'security';
  if (/\b(performance|latency|memory|speed|efficient|throughput)\b/.test(lower)) return 'performance';
  if (/\b(test|build|lint|run|install|command|npm|yarn|pnpm|ci)\b/.test(lower)) return 'build-test';
  if (/\b(architecture|module|design|structure|service|component)\b/.test(lower)) return 'architecture';
  if (/\b(style|format|naming|convention|typescript|javascript)\b/.test(lower)) return 'coding-style';
  return 'general';
}

function isTestPath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return /(^|\/)(__tests__|tests?|spec|fixtures|mocks?)(\/|$)/i.test(normalized)
    || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(normalized)
    || /test_.*\.py$/i.test(normalized)
    || /_test\.go$/i.test(normalized);
}

function normalizePath(filePath: string): string {
  return filePath.split(/[\\/]+/).join('/');
}
