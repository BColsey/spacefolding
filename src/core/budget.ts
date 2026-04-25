import type { ContextChunk, ContextTier } from '../types/index.js';
import type { RetrievalResult } from './retriever.js';

export interface BudgetResult {
  selected: ContextChunk[];
  tiers: Map<string, ContextTier>;
  totalTokens: number;
  budget: number;
  utilization: number;
  omitted: { chunkId: string; tokensEstimate: number; reason: string }[];
}

/**
 * Fill a token budget with the best-ranked chunks.
 * Prioritizes: hot-tier chunks first, then by retrieval score descending.
 * Optionally collapses sibling chunks (same parentId) into single entries.
 */
export function fillBudget(
  ranked: RetrievalResult[],
  chunks: Map<string, ContextChunk>,
  maxTokens: number,
  options?: {
    hotChunkIds?: Set<string>;
    collapseSiblings?: boolean;
  }
): BudgetResult {
  const hotIds = options?.hotChunkIds ?? new Set<string>();
  const selected: ContextChunk[] = [];
  const tiers = new Map<string, ContextTier>();
  const omitted: BudgetResult['omitted'] = [];
  const included = new Set<string>();
  let totalTokens = 0;

  // Phase 1: Always include hot-tier chunks that fit
  for (const result of ranked) {
    if (!hotIds.has(result.chunkId)) continue;
    const chunk = chunks.get(result.chunkId);
    if (!chunk) continue;
    if (totalTokens + chunk.tokensEstimate > maxTokens) {
      omitted.push({ chunkId: result.chunkId, tokensEstimate: chunk.tokensEstimate, reason: 'hot but exceeds budget' });
      continue;
    }
    selected.push(chunk);
    tiers.set(chunk.id, 'hot');
    included.add(chunk.id);
    totalTokens += chunk.tokensEstimate;
  }

  // Phase 2: Fill remaining budget with scored results
  for (const result of ranked) {
    if (included.has(result.chunkId)) continue;
    const chunk = chunks.get(result.chunkId);
    if (!chunk) continue;

    // Sibling collapsing: skip if a sibling is already included
    if (options?.collapseSiblings && chunk.parentId && included.has(chunk.parentId)) {
      omitted.push({ chunkId: result.chunkId, tokensEstimate: chunk.tokensEstimate, reason: 'parent already included' });
      continue;
    }

    if (totalTokens + chunk.tokensEstimate > maxTokens) {
      omitted.push({ chunkId: result.chunkId, tokensEstimate: chunk.tokensEstimate, reason: 'exceeds remaining budget' });
      continue;
    }

    selected.push(chunk);
    tiers.set(chunk.id, hotIds.has(result.chunkId) ? 'hot' : 'warm');
    included.add(chunk.id);
    totalTokens += chunk.tokensEstimate;
  }

  return {
    selected,
    tiers,
    totalTokens,
    budget: maxTokens,
    utilization: maxTokens > 0 ? totalTokens / maxTokens : 0,
    omitted,
  };
}
