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
    dependencies: DependencyLink[]
  ): ScoreResult {
    const hot: string[] = [];
    const warm: string[] = [];
    const cold: string[] = [];
    const finalReasons: Record<string, string[]> = {};

    const chunkMap = new Map(chunks.map((c) => [c.id, c]));

    // Initial tier assignment by score
    const tierMap = new Map<string, ContextTier>();
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

      // Override: constraints always promoted to hot if score > 0.3
      if (chunk.type === 'constraint' && tier !== 'hot' && score > 0.3) {
        tier = 'hot';
        chunkReasons.push('promoted to hot: constraint type');
      }

      // Override: instructions promoted to hot if score > 0.5
      if (chunk.type === 'instruction' && tier !== 'hot' && score > 0.5) {
        tier = 'hot';
        chunkReasons.push('promoted to hot: instruction type');
      }

      // Demote redundant hot chunks to warm
      if (tier === 'hot' && chunkReasons.some((r) => r.includes('redundant'))) {
        tier = 'warm';
        chunkReasons.push('demoted to warm: redundant with other chunk');
      }

      tierMap.set(chunk.id, tier);
      finalReasons[chunk.id] = chunkReasons;
    }

    // Dependency closure: promote warm deps of hot chunks
    const depLookup = new Map<string, DependencyLink[]>();
    for (const dep of dependencies) {
      const arr = depLookup.get(dep.fromId) ?? [];
      arr.push(dep);
      depLookup.set(dep.fromId, arr);
      const arr2 = depLookup.get(dep.toId) ?? [];
      arr2.push(dep);
      depLookup.set(dep.toId, arr2);
    }

    let changed = true;
    let iterations = 0;
    while (changed && iterations < 10) {
      changed = false;
      iterations++;
      for (const chunk of chunks) {
        if (tierMap.get(chunk.id) !== 'hot') continue;
        const links = depLookup.get(chunk.id) ?? [];
        for (const link of links) {
          const otherId = link.fromId === chunk.id ? link.toId : link.fromId;
          if (tierMap.get(otherId) === 'warm') {
            tierMap.set(otherId, 'hot');
            finalReasons[otherId].push('promoted to hot: dependency of hot chunk');
            changed = true;
          }
        }
      }
    }

    // Collect results
    for (const chunk of chunks) {
      const tier = tierMap.get(chunk.id) ?? 'cold';
      if (tier === 'hot') hot.push(chunk.id);
      else if (tier === 'warm') warm.push(chunk.id);
      else cold.push(chunk.id);
    }

    return { hot, warm, cold, scores, reasons: finalReasons };
  }
}
