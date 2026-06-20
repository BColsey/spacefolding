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
      // Word-boundary match only. Substring matching produced false positives
      // ("show" contains "how", "prefix" contains "fix") that polluted intent.
      if (words.includes(keyword)) score += 2;
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
 * Determine the retrieval strategy from the embedding provider.
 *
 * Justified by the contamination-free commit-derived benchmark (django /
 * typescript / rust) under the GPU code model — see
 * `benchmarks/COMMIT-DERIVED-FINDINGS.md` and `benchmarks/FROZEN-CLAIM.md`. The
 * earlier "vector-only beats hybrid by 7.5–19%" claim came from the retired,
 * train-on-test-contaminated self-corpus ablation and does NOT survive on the
 * honest benchmark: vector-only is in fact WORSE than the calibrated hybrid on
 * both recall and top-1 across all three measured languages.
 *
 * - `gpu` (real code embeddings, e.g. `Salesforce/SFR-Embedding-Code-400M_R`):
 *   `structural` — the calibrated hybrid (RRF over a strong vector arm + FTS at
 *   weights 0.20/0.70/0.70, plus the exact-identifier boost). Under GPU it is
 *   competitive with the strongest lexical baselines on R@10 and beats FTS on
 *   top-1 (Hits@1) on django+typescript — though a correct path-aware BM25F is the
 *   top-1 leader on django/rust (no universal winner; see FROZEN-CLAIM.md). It
 *   dominates vector-only on every language measured (django R@10 0.780 vs 0.868,
 *   H@1 0.310 vs 0.400; ts/rust likewise), so the old `gpu → vector` route is
 *   strictly dominated.
 * - `deterministic` (hash-based): `text` — deterministic embeddings are
 *   near-random vectors, so FTS5/BM25 keyword search is far more reliable.
 * - `local` (weaker general ONNX): `hybrid`. NOTE the bge counter-result: a
 *   *stronger general* model does not safely improve top-1 — fusion calibrated to
 *   trust the vector arm regresses Hits@1 — so do not assume "a better local
 *   model helps" without re-calibrating the per-model fusion weights.
 */
export function getAdaptiveStrategy(): RetrievalStrategy {
  const provider = process.env.EMBEDDING_PROVIDER ?? 'local';
  switch (provider) {
    case 'gpu':
      return 'structural';
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

  // Strategy is adaptive based on the embedding provider — see getAdaptiveStrategy
  // for the honest, commit-derived justification (gpu → calibrated structural
  // hybrid, deterministic → text, local → hybrid).
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
