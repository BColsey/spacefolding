import type {
  ContextChunk,
  ContextTier,
  DependencyLink,
  RoutingConfig,
  ScoreResult,
} from '../types/index.js';

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  weights: {
    semantic: 0.3,
    constraint: 0.25,
    recency: 0.2,
    redundancy: 0.1,
    dependency: 0.15,
  },
  thresholds: {
    hot: 0.7,
    warm: 0.4,
  },
};

export class ContextRouter {
  constructor(private config: RoutingConfig = DEFAULT_ROUTING_CONFIG) {}

  route(
    scores: Record<string, number>,
    reasons: Record<string, string[]>,
    chunks: ContextChunk[],
    dependencies: DependencyLink[],
    maxTokens?: number
  ): ScoreResult {
    const hot: string[] = [];
    const warm: string[] = [];
    const cold: string[] = [];
    const finalReasons: Record<string, string[]> = {};
    const tierMap = new Map<string, ContextTier>();
    const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const maxHotChunks = Math.max(1, Math.floor(chunks.length * 0.6));

    for (const chunk of chunks) {
      const score = scores[chunk.id] ?? 0;
      const chunkReasons = [...(reasons[chunk.id] ?? [])];

      let tier: ContextTier;
      if (score >= this.config.thresholds.hot) {
        tier = 'hot';
        chunkReasons.push(`score ${score.toFixed(3)} above hot threshold ${this.config.thresholds.hot}`);
      } else if (score >= this.config.thresholds.warm) {
        tier = 'warm';
        chunkReasons.push(`score ${score.toFixed(3)} above warm threshold ${this.config.thresholds.warm}`);
      } else {
        tier = 'cold';
        chunkReasons.push(`score ${score.toFixed(3)} below warm threshold ${this.config.thresholds.warm}`);
      }

      if (chunk.type === 'constraint' && tier !== 'hot' && score > 0.3) {
        tier = 'hot';
        chunkReasons.push('promoted to hot: constraint type');
      }

      if (chunk.type === 'instruction' && tier !== 'hot' && score > 0.5) {
        tier = 'hot';
        chunkReasons.push('promoted to hot: instruction type');
      }

      if (tier === 'hot' && chunkReasons.some((reason) => reason.includes('redundant'))) {
        tier = 'warm';
        chunkReasons.push('demoted to warm: redundant with other chunk');
      }

      tierMap.set(chunk.id, tier);
      finalReasons[chunk.id] = chunkReasons;
    }

    this.demoteLowestScoringHotChunks(
      tierMap,
      finalReasons,
      scores,
      chunks,
      maxHotChunks,
      'demoted to warm: hot tier capped at 60% of total chunks'
    );

    const depLookup = new Map<string, DependencyLink[]>();
    for (const dep of dependencies) {
      const fromLinks = depLookup.get(dep.fromId) ?? [];
      fromLinks.push(dep);
      depLookup.set(dep.fromId, fromLinks);

      const toLinks = depLookup.get(dep.toId) ?? [];
      toLinks.push(dep);
      depLookup.set(dep.toId, toLinks);
    }

    let changed = true;
    let iterations = 0;
    while (changed && iterations < 10 && this.getHotChunkIds(tierMap, chunks).length < maxHotChunks) {
      changed = false;
      iterations++;

      for (const chunk of chunks) {
        if (tierMap.get(chunk.id) !== 'hot') continue;
        if (this.getHotChunkIds(tierMap, chunks).length >= maxHotChunks) break;

        const links = depLookup.get(chunk.id) ?? [];
        for (const link of links) {
          if (this.getHotChunkIds(tierMap, chunks).length >= maxHotChunks) break;

          const otherId = link.fromId === chunk.id ? link.toId : link.fromId;
          if (tierMap.get(otherId) !== 'warm') continue;

          tierMap.set(otherId, 'hot');
          finalReasons[otherId].push('promoted to hot: dependency of hot chunk');
          changed = true;
        }
      }
    }

    this.demoteLowestScoringHotChunks(
      tierMap,
      finalReasons,
      scores,
      chunks,
      maxHotChunks,
      'demoted to warm: hot tier capped at 60% of total chunks'
    );

    if (maxTokens !== undefined) {
      let hotTokens = this.getHotTokens(tierMap, chunkMap);
      for (const chunkId of this.getHotChunkIds(tierMap, chunks).sort(
        (a, b) => (scores[a] ?? 0) - (scores[b] ?? 0)
      )) {
        if (hotTokens <= maxTokens) break;
        tierMap.set(chunkId, 'warm');
        finalReasons[chunkId].push('demoted to warm: hot tier exceeds token budget');
        hotTokens -= chunkMap.get(chunkId)?.tokensEstimate ?? 0;
      }
    }

    for (const chunk of chunks) {
      const tier = tierMap.get(chunk.id) ?? 'cold';
      if (tier === 'hot') hot.push(chunk.id);
      else if (tier === 'warm') warm.push(chunk.id);
      else cold.push(chunk.id);
    }

    return { hot, warm, cold, scores, reasons: finalReasons };
  }

  private demoteLowestScoringHotChunks(
    tierMap: Map<string, ContextTier>,
    reasons: Record<string, string[]>,
    scores: Record<string, number>,
    chunks: ContextChunk[],
    maxHotChunks: number,
    reason: string
  ): void {
    const hotChunkIds = this.getHotChunkIds(tierMap, chunks);
    if (hotChunkIds.length <= maxHotChunks) return;

    for (const chunkId of hotChunkIds
      .sort((a, b) => (scores[a] ?? 0) - (scores[b] ?? 0))
      .slice(0, hotChunkIds.length - maxHotChunks)) {
      tierMap.set(chunkId, 'warm');
      reasons[chunkId].push(reason);
    }
  }

  private getHotChunkIds(
    tierMap: Map<string, ContextTier>,
    chunks: ContextChunk[]
  ): string[] {
    return chunks
      .filter((chunk) => tierMap.get(chunk.id) === 'hot')
      .map((chunk) => chunk.id);
  }

  private getHotTokens(
    tierMap: Map<string, ContextTier>,
    chunkMap: Map<string, ContextChunk>
  ): number {
    let total = 0;
    for (const [chunkId, tier] of tierMap) {
      if (tier !== 'hot') continue;
      total += chunkMap.get(chunkId)?.tokensEstimate ?? 0;
    }
    return total;
  }
}
