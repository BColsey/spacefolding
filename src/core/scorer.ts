import type {
  TaskDescription,
  ContextChunk,
  RoutingConfig,
  EmbeddingProvider,
  TokenEstimator,
  DependencyLink,
} from '../types/index.js';
import { cosineSimilarity } from '../providers/deterministic-embedding.js';

export class ContextScorer {
  constructor(
    private config: RoutingConfig,
    private embeddingProvider: EmbeddingProvider,
    private tokenEstimator: TokenEstimator
  ) {}

  async scoreChunks(
    task: TaskDescription,
    chunks: ContextChunk[],
    dependencies: DependencyLink[] = []
  ): Promise<{ scores: Record<string, number>; reasons: Record<string, string[]> }> {
    const scores: Record<string, number> = {};
    const reasons: Record<string, string[]> = {};

    if (chunks.length === 0) return { scores, reasons };

    // Compute task embedding
    const taskEmbedding = await this.embeddingProvider.embed(task.text);

    // Compute all chunk embeddings
    const chunkEmbeddings = await this.embeddingProvider.embedBatch(
      chunks.map((c) => c.text)
    );

    const w = this.config.weights;
    const now = Date.now();
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

    // Build dependency lookup
    const depsFor = new Map<string, DependencyLink[]>();
    for (const dep of dependencies) {
      const arr = depsFor.get(dep.fromId) ?? [];
      arr.push(dep);
      depsFor.set(dep.fromId, arr);
      const arr2 = depsFor.get(dep.toId) ?? [];
      arr2.push(dep);
      depsFor.set(dep.toId, arr2);
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkReasons: string[] = [];

      // Semantic similarity
      const semanticScore = cosineSimilarity(taskEmbedding, chunkEmbeddings[i]);
      chunkReasons.push(`semantic similarity: ${semanticScore.toFixed(3)}`);

      // Constraint score
      let constraintScore = 0.2;
      if (chunk.type === 'constraint') constraintScore = 1.0;
      else if (chunk.type === 'instruction') constraintScore = 0.5;
      chunkReasons.push(`type score: ${constraintScore.toFixed(2)} (${chunk.type})`);

      // Recency score (7-day linear decay)
      const age = now - chunk.timestamp;
      const recencyScore = Math.max(0, 1 - age / SEVEN_DAYS);
      chunkReasons.push(`recency: ${recencyScore.toFixed(3)}`);

      // Redundancy penalty
      let redundancyPenalty = 0;
      for (let j = 0; j < chunks.length; j++) {
        if (i === j) continue;
        const sim = cosineSimilarity(chunkEmbeddings[i], chunkEmbeddings[j]);
        if (sim > 0.8) {
          redundancyPenalty += 0.3;
          chunkReasons.push(`redundant with chunk ${chunks[j].id.slice(0, 8)}`);
        }
      }
      const redundancyScore = Math.max(0, 1 - redundancyPenalty);

      // Dependency score: boost if linked to high-scoring chunks
      let dependencyScore = 0;
      const links = depsFor.get(chunk.id) ?? [];
      if (links.length > 0) {
        dependencyScore = Math.min(0.5, links.length * 0.15);
        chunkReasons.push(`dependency boost: +${dependencyScore.toFixed(2)} (${links.length} links)`);
      }

      // Weighted combination
      const total =
        w.semantic * semanticScore +
        w.constraint * constraintScore +
        w.recency * recencyScore +
        w.redundancy * redundancyScore +
        w.dependency * dependencyScore;

      // Clamp to [0, 1]
      const clamped = Math.max(0, Math.min(1, total));
      scores[chunk.id] = clamped;
      reasons[chunk.id] = chunkReasons;
    }

    // Second pass: dependency boost based on already-scored chunks
    for (const chunk of chunks) {
      const links = depsFor.get(chunk.id) ?? [];
      let boost = 0;
      for (const link of links) {
        const otherId = link.fromId === chunk.id ? link.toId : link.fromId;
        if (scores[otherId] !== undefined && scores[otherId] > 0.7) {
          boost += 0.1 * link.weight;
        }
      }
      if (boost > 0) {
        scores[chunk.id] = Math.min(1, scores[chunk.id] + boost);
        reasons[chunk.id].push(`dependency closure boost: +${boost.toFixed(3)}`);
      }
    }

    return { scores, reasons };
  }
}
