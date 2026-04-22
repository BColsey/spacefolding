// ============================================================
// Context Steward - Core Types & Interfaces
// ============================================================

// --- Chunk Types ---

/** The kind of content a chunk represents */
export type ChunkType =
  | 'fact'
  | 'constraint'
  | 'instruction'
  | 'code'
  | 'log'
  | 'background'
  | 'summary'
  | 'diff'
  | 'reference';

/** Routing tier assignment */
export type ContextTier = 'hot' | 'warm' | 'cold';

/** How two chunks relate */
export type DependencyType =
  | 'references'
  | 'defines'
  | 'summarizes'
  | 'overrides'
  | 'contains';

// --- Core Data Structures ---

/** A single unit of context */
export interface ContextChunk {
  id: string;
  source: string;
  type: ChunkType;
  text: string;
  timestamp: number;
  path?: string;
  language?: string;
  tokensEstimate: number;
  parentId?: string;
  childrenIds: string[];
  metadata: Record<string, unknown>;
}

/** A directed link between two chunks */
export interface DependencyLink {
  fromId: string;
  toId: string;
  type: DependencyType;
  weight: number;
}

/** Why a chunk was assigned to a tier */
export interface RoutingDecision {
  chunkId: string;
  tier: ContextTier;
  score: number;
  reasons: string[];
}

/** Complete scoring + routing output */
export interface ScoreResult {
  hot: string[];
  warm: string[];
  cold: string[];
  scores: Record<string, number>;
  reasons: Record<string, string[]>;
}

/** Output of compressing warm context */
export interface CompressionResult {
  summary: string;
  retainedFacts: string[];
  retainedConstraints: string[];
  sourceChunkIds: string[];
}

/** The task to score context against */
export interface TaskDescription {
  text: string;
  type?: string;
  priority?: string;
}

/** Filter for querying chunks */
export interface ContextFilter {
  source?: string;
  type?: ChunkType;
  tier?: ContextTier;
  path?: string;
  textContains?: string;
}

// --- Routing Configuration ---

export interface RoutingWeights {
  semantic: number;
  constraint: number;
  recency: number;
  redundancy: number;
  dependency: number;
}

export interface RoutingThresholds {
  hot: number;
  warm: number;
}

export interface RoutingConfig {
  weights: RoutingWeights;
  thresholds: RoutingThresholds;
}

export declare function cosineSimilarity(a: number[], b: number[]): number;

// --- Provider Interfaces ---

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export interface RerankerProvider {
  rerank(
    query: string,
    documents: string[]
  ): Promise<{ index: number; score: number; reason: string }[]>;
}

export interface CompressionProvider {
  compress(task: TaskDescription, chunks: ContextChunk[]): Promise<CompressionResult>;
}

export interface TokenEstimator {
  estimate(text: string): number;
}

export interface DependencyAnalyzer {
  analyze(chunks: ContextChunk[]): DependencyLink[];
}

export interface StorageProvider {
  storeChunk(chunk: ContextChunk): void;
  getChunk(id: string): ContextChunk | null;
  queryChunks(filter: ContextFilter): ContextChunk[];
  updateChunk(chunk: ContextChunk): void;
  deleteChunk(id: string): void;
  storeDependency(link: DependencyLink): void;
  removeDependency(fromId: string, toId: string, type: DependencyType): void;
  removeAllDependenciesForChunk(chunkId: string): void;
  getDependencies(chunkId: string): DependencyLink[];
}

// --- MCP Tool Types ---

export interface MCPScoreInput {
  task: TaskDescription;
  chunkIds?: string[];
  maxTokens?: number;
}

export type MCPScoreOutput = ScoreResult;

export interface MCPCompressInput {
  task: TaskDescription;
  chunkIds: string[];
}

export type MCPCompressOutput = CompressionResult;

export interface MCPMemoryInput {
  task: TaskDescription;
  filters?: ContextFilter;
}

export interface MCPMemoryOutput {
  chunks: ContextChunk[];
  explanations: string[];
}

export interface MCPIngestInput {
  source: string;
  text: string;
  type?: ChunkType;
  path?: string;
  language?: string;
}

export interface MCPIngestOutput {
  chunkId: string;
}

export interface MCPGraphInput {
  chunkId: string;
  operation: 'add' | 'remove';
  dependencies: DependencyLink[];
}

export interface MCPGraphOutput {
  links: DependencyLink[];
}

export interface MCPExplainInput {
  task: TaskDescription;
  chunkId?: string;
}

export interface MCPExplainOutput {
  routing: RoutingDecision[];
  summary: string;
}

// --- App Configuration ---

export interface AppConfig {
  dbPath: string;
  transport: 'stdio' | 'sse';
  port: number;
  routing: RoutingConfig;
}

// --- Feature Types ---
export interface SymbolInfo {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'method';
  line: number;
  filePath?: string;
}

export interface GitChange {
  filePath: string;
  changeType: 'added' | 'modified' | 'deleted';
  hunks: number;
}

export interface ExportData {
  version: number;
  exportedAt: number;
  chunks: ContextChunk[];
  dependencies: DependencyLink[];
}
