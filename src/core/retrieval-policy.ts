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
  /**
   * Absolute fused-score floor, applied together with the relative
   * `scoreThresholdRatio` (a candidate must clear `max(relative, absolute)`).
   * `0` disables it. See {@link ABSOLUTE_SCORE_FLOOR}.
   */
  absoluteScoreFloor: number;
  maxChunksPerPath: number | null;
}

export interface RetrievalSelectionResult {
  ranked: RetrievalResult[];
  policy: RetrievalSelectionPolicy;
  dropped: Array<{ chunkId: string; reason: string }>;
}

const FOCUSED_TARGETS: Record<RetrievalComplexity, number> = {
  narrow: 6_000,
  moderate: 13_000,
  broad: 18_000,
};

const BROAD_TARGETS: Record<RetrievalComplexity, number> = {
  narrow: 16_000,
  moderate: 28_000,
  broad: 40_000,
};

// Reciprocal-rank-fusion constants mirrored from the retriever's fusion
// (retriever.ts: RRF_K = 60; the GPU/CI harness retrieves to depth ~200). They
// are kept as local literals so this policy module stays free of any runtime
// dependency on the retriever — they are documented invariants, not tuning knobs.
const RRF_K = 60;
const RETRIEVAL_TAIL_RANK = 200;

/**
 * Absolute fused-score floor: a fixed tail threshold `1 / (RRF_K + 200)` ≈ 0.0038.
 * Post-RRF fused scores are sums of `weight / (RRF_K + rank)` contributions, so
 * they live on one consistent, corpus-independent scale regardless of strategy.
 *
 * The threshold equals the contribution a *unit-weight* source would make at the
 * deepest retrieved rank (~200). In the strategies where this floor is actually
 * active (focused/broad — exhaustive sets it to 0), the live fusion weights are
 * sub-unit (the `structural` strategy uses vector/fts ≈ 0.7 and structural ≈ 0.2),
 * so in practice the floor trims a candidate that is supported ONLY by a single
 * weak or deep arm:
 *   - a structural-only fuzzy hit (≈ 0.2/61 ≈ 0.0033) — note an *exact* identifier
 *     match is never affected: it carries the large exact-identifier boost,
 *   - or a single 0.7-weight (vector/fts) hit ranked deeper than ~125 (0.7/186 ≈ 0.0038).
 * Any candidate corroborated by two arms, or holding a strong single-arm rank,
 * sits well above the floor.
 *
 * The relative `scoreThresholdRatio` alone cannot catch weak tails when the whole
 * result set is weak (`threshold = tiny topScore × ratio` is itself tiny), so
 * retrieval would otherwise always return topK even when nothing is relevant.
 * Because the floor is taken as `max(relative, absolute)` it is a no-op whenever a
 * strong result exists (the relative threshold dominates) and only bites on an
 * all-weak set — and even then `minKeep` and the keep-at-least-one fallback below
 * protect the head, so retrieval never returns empty for a non-empty input.
 */
const ABSOLUTE_SCORE_FLOOR = 1 / (RRF_K + RETRIEVAL_TAIL_RANK);

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
      // Exhaustive returns everything up to the hard budget — no floor.
      absoluteScoreFloor: 0,
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
      absoluteScoreFloor: ABSOLUTE_SCORE_FLOOR,
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
    absoluteScoreFloor: ABSOLUTE_SCORE_FLOOR,
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
  const candidates: RetrievalResult[] = [];

  for (const result of retrieval) {
    const chunk = chunks.get(result.chunkId);
    if (!chunk) {
      dropped.push({ chunkId: result.chunkId, reason: 'chunk not found' });
      continue;
    }
    if (chunk.metadata?.split) {
      dropped.push({ chunkId: result.chunkId, reason: 'split parent metadata chunk' });
      continue;
    }
    candidates.push(result);
  }

  const topScore = candidates[0]?.score ?? 0;
  const relativeThreshold = topScore * policy.scoreThresholdRatio;
  // Fail safe: a hand-built / Partial policy without absoluteScoreFloor must
  // behave as floor-off, not NaN (which would silently disable ALL trimming via
  // Math.max(x, NaN) === NaN).
  const absoluteFloor = Number.isFinite(policy.absoluteScoreFloor) ? policy.absoluteScoreFloor : 0;
  // A candidate must clear BOTH the relative threshold (proportional to the top
  // hit) and the absolute floor (a fixed minimum fused score). Taking the max
  // means the absolute floor only bites when the relative threshold is too weak
  // to — i.e. when the whole result set is weak — so a strong query is unaffected.
  const effectiveThreshold = Math.max(relativeThreshold, absoluteFloor);

  for (let index = 0; index < candidates.length; index++) {
    if (selected.length >= policy.candidateLimit) {
      dropped.push({ chunkId: candidates[index].chunkId, reason: 'after candidate limit' });
      continue;
    }

    const result = candidates[index];
    const chunk = chunks.get(result.chunkId);
    if (!chunk) continue;
    const isProtected = index < policy.minKeep;

    if (!isProtected && effectiveThreshold > 0 && result.score < effectiveThreshold) {
      const reason = result.score < absoluteFloor
        ? 'below absolute relevance floor'
        : `below ${policy.mode} score threshold`;
      dropped.push({ chunkId: result.chunkId, reason });
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
