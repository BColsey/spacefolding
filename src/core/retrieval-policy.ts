import type { ContextChunk } from '../types/index.js';
import type { RetrievalMode, RetrievalResult } from './retriever.js';

export type RetrievalComplexity = 'narrow' | 'moderate' | 'broad';

export interface RetrievalSelectionPolicy {
  mode: RetrievalMode;
  hardBudget: number;
  targetBudget: number;
  candidateLimit: number;
  minKeep: number;
  scoreThresholdRatio: number;
  maxChunksPerPath: number | null;
}

export interface RetrievalSelectionResult {
  ranked: RetrievalResult[];
  policy: RetrievalSelectionPolicy;
  dropped: Array<{ chunkId: string; reason: string }>;
}

const FOCUSED_TARGETS: Record<RetrievalComplexity, number> = {
  narrow: 8_000,
  moderate: 17_000,
  broad: 24_000,
};

const BROAD_TARGETS: Record<RetrievalComplexity, number> = {
  narrow: 16_000,
  moderate: 28_000,
  broad: 40_000,
};

export function createRetrievalSelectionPolicy(options: {
  mode?: RetrievalMode;
  complexity: RetrievalComplexity;
  hardBudget: number;
  requestedTopK: number;
  returnLimit?: number;
}): RetrievalSelectionPolicy {
  const mode = options.mode ?? 'focused';
  const candidateLimit = options.returnLimit ?? options.requestedTopK;

  if (mode === 'exhaustive') {
    return {
      mode,
      hardBudget: options.hardBudget,
      targetBudget: options.hardBudget,
      candidateLimit,
      minKeep: 0,
      scoreThresholdRatio: 0,
      maxChunksPerPath: null,
    };
  }

  if (mode === 'broad') {
    return {
      mode,
      hardBudget: options.hardBudget,
      targetBudget: Math.min(options.hardBudget, BROAD_TARGETS[options.complexity]),
      candidateLimit,
      minKeep: 5,
      scoreThresholdRatio: 0.2,
      maxChunksPerPath: 3,
    };
  }

  return {
    mode: 'focused',
    hardBudget: options.hardBudget,
    targetBudget: Math.min(options.hardBudget, FOCUSED_TARGETS[options.complexity]),
    candidateLimit,
    minKeep: 3,
    scoreThresholdRatio: 0.35,
    maxChunksPerPath: 2,
  };
}

export function selectRetrievalCandidates(
  retrieval: RetrievalResult[],
  chunks: Map<string, ContextChunk>,
  policy: RetrievalSelectionPolicy
): RetrievalSelectionResult {
  const selected: RetrievalResult[] = [];
  const dropped: RetrievalSelectionResult['dropped'] = [];
  const pathCounts = new Map<string, number>();
  const candidates = retrieval.filter((result) => {
    const chunk = chunks.get(result.chunkId);
    return chunk && !chunk.metadata?.split;
  });
  const topScore = candidates[0]?.score ?? 0;
  const threshold = topScore * policy.scoreThresholdRatio;

  for (let index = 0; index < candidates.length; index++) {
    if (selected.length >= policy.candidateLimit) {
      dropped.push({ chunkId: candidates[index].chunkId, reason: 'after candidate limit' });
      continue;
    }

    const result = candidates[index];
    const chunk = chunks.get(result.chunkId);
    if (!chunk) continue;
    const isProtected = index < policy.minKeep;

    if (!isProtected && policy.scoreThresholdRatio > 0 && result.score < threshold) {
      dropped.push({ chunkId: result.chunkId, reason: 'below focused score threshold' });
      continue;
    }

    const pathKey = chunk.path ?? chunk.source ?? chunk.id;
    const currentPathCount = pathCounts.get(pathKey) ?? 0;
    if (
      !isProtected &&
      policy.maxChunksPerPath !== null &&
      currentPathCount >= policy.maxChunksPerPath
    ) {
      dropped.push({ chunkId: result.chunkId, reason: 'per-path candidate cap' });
      continue;
    }

    selected.push(result);
    pathCounts.set(pathKey, currentPathCount + 1);
  }

  if (selected.length === 0 && candidates[0]) {
    selected.push(candidates[0]);
  }

  return { ranked: selected, policy, dropped };
}

export function budgetForSelectedCandidates(
  selected: RetrievalResult[],
  chunks: Map<string, ContextChunk>,
  policy: RetrievalSelectionPolicy
): number {
  if (policy.mode === 'exhaustive') return policy.hardBudget;

  let protectedTokens = 0;
  for (const result of selected.slice(0, policy.minKeep)) {
    protectedTokens += chunks.get(result.chunkId)?.tokensEstimate ?? 0;
  }

  return Math.min(policy.hardBudget, Math.max(policy.targetBudget, protectedTokens));
}
