export type QueryIntent = 'code_search' | 'debug' | 'explain' | 'implement' | 'general';

export interface QueryPlan {
  intent: QueryIntent;
  expandedTerms: string[];
  strategy: 'hybrid' | 'vector' | 'text' | 'graph';
  maxHops: number;
  tokenBudgetRatio: number; // fraction of max tokens to use
  complexity: 'narrow' | 'moderate' | 'broad'; // query scope estimate
}

const INTENT_KEYWORDS: Record<QueryIntent, string[]> = {
  debug: ['error', 'bug', 'fail', 'crash', 'broken', 'fix', 'issue', 'exception', 'trace', 'wrong', 'unexpected'],
  implement: ['add', 'create', 'build', 'implement', 'write', 'make', 'new', 'feature', 'support'],
  explain: ['how', 'why', 'what', 'explain', 'understand', 'describe', 'meaning', 'purpose', 'does'],
  code_search: ['where', 'find', 'locate', 'search', 'show', 'grep', 'file', 'function', 'class', 'module'],
  general: [],
};

// Broadening signals: queries mentioning "all", "entire", "everything", "whole" suggest wider scope
const BROADENING_TERMS = new Set([
  'all', 'entire', 'everything', 'whole', 'comprehensive', 'complete',
  'full', 'overall', 'architecture', 'system', 'overview', 'every',
  'and', 'multiple', 'various', 'several',
]);

// Narrowing signals: queries with specific file paths, function names, or "exact" language
const NARROWING_TERMS = new Set([
  'exact', 'specific', 'only', 'just', 'single', 'one', 'this',
  'exact', 'precise', 'particular',
]);

/** Detect the primary intent of a query */
export function detectIntent(query: string): QueryIntent {
  const lower = query.toLowerCase();
  const words = lower.split(/\s+/);

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

/** Extract key terms from a query for expansion */
export function expandQuery(query: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
    'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we',
    'how', 'why', 'what', 'who', 'when', 'where', 'which', 'than', 'then',
  ]);

  const words = query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  // Deduplicate preserving order
  return [...new Set(words)];
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
  if (/[a-z]+\/[a-z]+/.test(lower) || /\.(ts|js|py|rs|go)$/.test(lower)) {
    narrowSignals += 2;
  }

  // Many terms = broader query
  if (termCount >= 6) broadSignals++;
  if (termCount <= 2) narrowSignals++;

  if (narrowSignals > broadSignals + 1) return 'narrow';
  if (broadSignals > narrowSignals + 1) return 'broad';
  return 'moderate';
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

/** Create a retrieval plan from a query */
export function planQuery(query: string): QueryPlan {
  const intent = detectIntent(query);
  const expandedTerms = expandQuery(query);
  const complexity = estimateComplexity(query, expandedTerms);

  // All intents default to vector-only retrieval.
  // Ablation testing showed vector-only with strong embeddings (GTE-ModernBERT)
  // beats hybrid (vector+FTS5+graph) on all metrics: R@10 +7.5%, NDCG +16.8%, MRR +18.9%.
  // Graph traversal degrades NDCG/MRR by ~22% across all models.
  const tokenBudgetRatio = adaptiveBudgetRatio(intent, complexity);

  return {
    intent,
    expandedTerms,
    strategy: 'vector',
    maxHops: 0,
    tokenBudgetRatio,
    complexity,
  };
}
