import type { ContextChunk, ContextTier } from '../types/index.js';
import type { RetrievalResult } from './retriever.js';

export interface BudgetResult {
  selected: ContextChunk[];
  tiers: Map<string, ContextTier>;
  totalTokens: number;
  budget: number;
  utilization: number;
  omitted: { chunkId: string; tokensEstimate: number; reason: string }[];
  compressed: { chunkId: string; summary: string; tokensEstimate: number }[];
}

export interface CompressOmittedOptions {
  /** Estimate compressed token count from original token count */
  estimateCompressed: (originalTokens: number) => number;
  /** Compress a chunk into a summary string */
  compress: (chunkId: string) => Promise<{ summary: string; tokensEstimate: number } | null>;
  /** Max number of omitted chunks to attempt compression on (default: 5) */
  maxCompress?: number;
}

export interface BudgetOptions {
  hotChunkIds?: Set<string>;
  collapseSiblings?: boolean;
  /** If provided, compress omitted chunks that could fit when compressed */
  compressOmitted?: CompressOmittedOptions;
}

/**
 * Fill a token budget with the best-ranked chunks.
 * Prioritizes: hot-tier chunks first, then by retrieval score descending.
 * Optionally collapses sibling chunks (same parentId) into single entries.
 * Optionally compresses omitted chunks to fit summaries within the budget.
 */
export function fillBudget(
  ranked: RetrievalResult[],
  chunks: Map<string, ContextChunk>,
  maxTokens: number,
  options?: BudgetOptions
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
    included.add(result.chunkId);
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
    included.add(result.chunkId);
    totalTokens += chunk.tokensEstimate;
  }

  return {
    selected,
    tiers,
    totalTokens,
    budget: maxTokens,
    utilization: maxTokens > 0 ? totalTokens / maxTokens : 0,
    omitted,
    compressed: [],
  };
}

/**
 * Attempt to compress omitted chunks and fit their summaries within the remaining budget.
 * Mutates the BudgetResult in place, adding compressed summaries.
 * Returns the list of successfully compressed chunks.
 */
export async function compressOmitted(
  result: BudgetResult,
  ranked: RetrievalResult[],
  chunks: Map<string, ContextChunk>,
  options: CompressOmittedOptions
): Promise<{ chunkId: string; summary: string; tokensEstimate: number }[]> {
  const remaining = result.budget - result.totalTokens;
  if (remaining <= 0) return [];

  const maxCompress = options.maxCompress ?? 5;

  // Sort omitted chunks by retrieval score (most relevant first)
  // Only compress chunks that exceeded the budget — not siblings or hot-overflow
  const compressible = result.omitted
    .filter((o) => o.reason === 'exceeds remaining budget')
    .sort((a, b) => {
      const scoreA = ranked.find((r) => r.chunkId === a.chunkId)?.score ?? 0;
      const scoreB = ranked.find((r) => r.chunkId === b.chunkId)?.score ?? 0;
      return scoreB - scoreA;
    })
    .slice(0, maxCompress);

  const compressed: { chunkId: string; summary: string; tokensEstimate: number }[] = [];

  for (const omitted of compressible) {
    const estimatedSize = options.estimateCompressed(omitted.tokensEstimate);
    if (result.totalTokens + estimatedSize > result.budget) continue; // Even compressed won't fit

    const compressedResult = await options.compress(omitted.chunkId);
    if (!compressedResult) continue;

    if (result.totalTokens + compressedResult.tokensEstimate > result.budget) continue;

    // Create a synthetic compressed chunk
    const originalChunk = chunks.get(omitted.chunkId);
    if (!originalChunk) continue;

    const syntheticChunk: ContextChunk = {
      ...originalChunk,
      id: `${originalChunk.id}__compressed`,
      text: compressedResult.summary,
      tokensEstimate: compressedResult.tokensEstimate,
      metadata: { ...originalChunk.metadata, compressedFrom: originalChunk.id },
    };

    result.selected.push(syntheticChunk);
    result.tiers.set(syntheticChunk.id, 'compressed');
    result.totalTokens += compressedResult.tokensEstimate;
    result.utilization = result.budget > 0 ? result.totalTokens / result.budget : 0;
    result.omitted = result.omitted.filter((o) => o.chunkId !== omitted.chunkId);

    compressed.push({
      chunkId: omitted.chunkId,
      summary: compressedResult.summary,
      tokensEstimate: compressedResult.tokensEstimate,
    });
  }

  result.compressed = compressed;
  return compressed;
}
