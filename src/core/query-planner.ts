import type { RetrievalStrategy, StructuralQuery } from '../types/index.js';
import { normalizeIdentifier, normalizeSymbolName, splitIdentifier } from '../providers/structural-indexer.js';

export type QueryIntent = 'code_search' | 'debug' | 'explain' | 'implement' | 'general';

export interface QueryPlan {
  intent: QueryIntent;
  expandedTerms: string[];
  strategy: RetrievalStrategy;
  maxHops: number;
  tokenBudgetRatio: number; // fraction of max tokens to use
  complexity: 'narrow' | 'moderate' | 'broad'; // query scope estimate
  structuralQuery: StructuralQuery;
  recommendedTopK: number;
}

const INTENT_KEYWORDS: Record<QueryIntent, string[]> = {
  debug: ['error', 'bug', 'fail', 'crash', 'broken', 'fix', 'issue', 'exception', 'trace', 'wrong', 'unexpected'],
  implement: ['add', 'create', 'build', 'implement', 'write', 'make', 'new', 'feature', 'support', 'switch', 'update', 'change', 'modify', 'enhance'],
  explain: ['how', 'why', 'what', 'explain', 'understand', 'describe', 'meaning', 'purpose', 'does'],
  code_search: ['where', 'find', 'locate', 'search', 'show', 'grep', 'file', 'function', 'class', 'module'],
  general: [],
};

const MUTATION_TERMS = new Set([
  'add', 'build', 'change', 'create', 'enhance', 'extend', 'implement',
  'improve', 'make', 'modify', 'refactor', 'switch', 'update', 'write',
]);

const LOOKUP_OPENING = /^(where|find|locate|show|grep|which\s+file)\b/i;

// Broadening signals: queries mentioning "all", "entire", "everything", "whole" suggest wider scope
const BROADENING_TERMS = new Set([
  'all', 'entire', 'everything', 'whole', 'comprehensive', 'complete',
  'full', 'overall', 'architecture', 'system', 'overview', 'every',
  'multiple', 'various', 'several',
]);

// Narrowing signals: queries with specific file paths, function names, or "exact" language
const NARROWING_TERMS = new Set([
  'exact', 'specific', 'only', 'just', 'single', 'one', 'this',
  'precise', 'particular',
]);

/** Detect the primary intent of a query */
export function detectIntent(query: string): QueryIntent {
  const lower = query.toLowerCase();
  const words = lower.split(/\s+/);

  if (!LOOKUP_OPENING.test(lower) && words.some((word) => MUTATION_TERMS.has(word))) {
    return 'implement';
  }

  let bestIntent: QueryIntent = 'general';
  let bestScore = 0;

  for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (words.includes(keyword)) score += 2;
      else if (lower.includes(keyword)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent as QueryIntent;
    }
  }

  return bestIntent;
}

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
    'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we',
    'how', 'why', 'what', 'who', 'when', 'where', 'which', 'than', 'then',
    'please', 'using', 'use', 'uses', 'used', 'add', 'fix', 'find',
  ]);

/** Extract key terms from a query for expansion */
export function expandQuery(query: string): string[] {
  const words = query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  // Deduplicate preserving order
  return [...new Set(words)];
}

/** Parse code-aware query features for structural retrieval. */
export function parseStructuralQuery(query: string): StructuralQuery {
  const quotedTerms = [...query.matchAll(/"([^"]+)"|'([^']+)'/g)]
    .map((match) => match[1] ?? match[2])
    .filter(Boolean);

  const pathFragments = [
    ...query.matchAll(/(?:[\w.-]+\/)+[\w.-]+(?:\.[A-Za-z0-9]+)?/g),
    ...query.matchAll(/\b[\w.-]+\.(?:ts|tsx|js|jsx|py|rs|go|java)\b/g),
  ]
    .map((match) => match[0])
    .filter((value, index, all) => all.indexOf(value) === index);

  const extensions = [...query.matchAll(/\.(ts|tsx|js|jsx|py|rs|go|java)\b/gi)]
    .map((match) => match[1].toLowerCase())
    .filter((value, index, all) => all.indexOf(value) === index);

  const rawIdentifiers = [
    ...query.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g),
  ]
    .map((match) => match[0])
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word.toLowerCase()));

  for (const quoted of quotedTerms) {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(quoted)) rawIdentifiers.push(quoted);
  }

  for (const path of pathFragments) {
    const filename = path.split('/').pop() ?? path;
    const withoutExt = filename.replace(/\.[^.]+$/, '');
    if (withoutExt.length > 1) rawIdentifiers.push(withoutExt);
  }

  const identifiers = [...new Set(rawIdentifiers)];
  const identifierParts = [...new Set(identifiers.flatMap(splitIdentifier))]
    .filter((part) => part.length > 1 && !STOP_WORDS.has(part));
  const normalizedIdentifiers = [...new Set([
    ...identifiers.map(normalizeSymbolName),
    ...identifierParts.map(normalizeSymbolName),
    ...quotedTerms.map(normalizeSymbolName),
  ])].filter(Boolean);

  const pathTokens = [...new Set(pathFragments.flatMap((fragment) =>
    fragment
      .toLowerCase()
      .split(/[/. _-]+/)
      .filter((part) => part.length > 1 && !STOP_WORDS.has(part))
  ))];

  return {
    raw: query,
    tokens: expandQuery(query),
    identifiers,
    normalizedIdentifiers,
    identifierParts,
    pathFragments,
    pathTokens,
    extensions,
    quotedTerms: quotedTerms.map(normalizeIdentifier),
  };
}

/** Estimate query complexity/scope for adaptive budget sizing */
export function estimateComplexity(query: string, expandedTerms: string[]): 'narrow' | 'moderate' | 'broad' {
  const lower = query.toLowerCase();
  const words = lower.split(/\s+/);
  const termCount = expandedTerms.length;

  // Count broadening vs narrowing signals
  let broadSignals = 0;
  let narrowSignals = 0;
  for (const word of words) {
    if (BROADENING_TERMS.has(word)) broadSignals++;
    if (NARROWING_TERMS.has(word)) narrowSignals++;
  }

  // Path-like patterns (src/foo/bar.ts) indicate narrow targeting
  if (/[a-z0-9_.-]+\/[a-z0-9_.-]+/.test(lower) || /\.(ts|tsx|js|jsx|py|rs|go|java)\b/.test(lower)) {
    narrowSignals += 2;
  }

  if (/\b[A-Za-z_$][A-Za-z0-9_$]*\(\)/.test(query) || /\b[A-Za-z]+(?:[A-Z][a-z0-9]+)+\b/.test(query) || /\b[a-z]+_[a-z0-9_]+\b/.test(query)) {
    narrowSignals++;
  }

  // Long queries are common for concrete coding tasks. Treat them as broad
  // only when they also contain explicit broadening language.
  if (termCount >= 8 && broadSignals > 0) broadSignals++;
  if (termCount <= 2) narrowSignals++;

  if (narrowSignals > broadSignals + 1) return 'narrow';
  if (broadSignals > narrowSignals + 1) return 'broad';
  return 'moderate';
}

export type { RetrievalStrategy } from '../types/index.js';

/**
 * Determine the optimal retrieval strategy based on the embedding provider.
 *
 * - `gpu` (GTE-ModernBERT, etc.): vector-only is best — ablation testing showed
 *   vector-only beats hybrid by 7.5-19% on R@10, NDCG, and MRR with strong GPU embeddings.
 * - `local` (all-MiniLM-L6-v2, etc.): hybrid (vector + FTS5) is better — weaker local
 *   ONNX embeddings benefit from keyword search as a complement.
 * - `deterministic` (hash-based): text-only is best — deterministic embeddings produce
 *   near-random vectors (R@10 = 0.362), so FTS5/BM25 keyword search is far more reliable.
 */
export function getAdaptiveStrategy(): RetrievalStrategy {
  const provider = process.env.EMBEDDING_PROVIDER ?? 'local';
  switch (provider) {
    case 'gpu':
      return 'vector';
    case 'deterministic':
      return 'text';
    case 'local':
    default:
      return 'hybrid';
  }
}

/** Compute adaptive budget ratio based on intent + complexity */
function adaptiveBudgetRatio(intent: QueryIntent, complexity: 'narrow' | 'moderate' | 'broad'): number {
  // Base ratios per intent
  const baseRatio: Record<QueryIntent, number> = {
    debug: 0.6,
    implement: 0.4,
    explain: 0.3,
    code_search: 0.35,
    general: 0.5,
  };

  const base = baseRatio[intent];

  // Complexity adjustment:
  // - narrow: reduce budget (fewer, more targeted results needed)
  // - broad: increase budget (wider context needed)
  switch (complexity) {
    case 'narrow': return Math.max(0.15, base * 0.7);
    case 'broad': return Math.min(0.8, base * 1.3);
    default: return base;
  }
}

export function adaptiveTopK(intent: QueryIntent, complexity: 'narrow' | 'moderate' | 'broad'): number {
  if (complexity === 'broad') return 15;
  if (complexity === 'narrow' || intent === 'code_search') return 5;
  return intent === 'debug' || intent === 'implement' || intent === 'explain' ? 10 : 8;
}

/** Create a retrieval plan from a query */
export function planQuery(query: string): QueryPlan {
  const intent = detectIntent(query);
  const expandedTerms = expandQuery(query);
  const complexity = estimateComplexity(query, expandedTerms);
  const structuralQuery = parseStructuralQuery(query);

  // Strategy is adaptive based on embedding model quality:
  // - GPU embeddings (GTE-ModernBERT): vector-only is optimal
  // - Local ONNX (all-MiniLM-L6-v2): hybrid (vector + FTS5) compensates for weaker vectors
  // - Deterministic (hash-based): text-only since vectors are near-random
  const tokenBudgetRatio = adaptiveBudgetRatio(intent, complexity);

  return {
    intent,
    expandedTerms,
    strategy: getAdaptiveStrategy(),
    maxHops: 0,
    tokenBudgetRatio,
    complexity,
    structuralQuery,
    recommendedTopK: adaptiveTopK(intent, complexity),
  };
}
