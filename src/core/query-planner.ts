export type QueryIntent = 'code_search' | 'debug' | 'explain' | 'implement' | 'general';

export interface QueryPlan {
  intent: QueryIntent;
  expandedTerms: string[];
  strategy: 'hybrid' | 'vector' | 'text' | 'graph';
  maxHops: number;
  tokenBudgetRatio: number; // fraction of max tokens to use
}

const INTENT_KEYWORDS: Record<QueryIntent, string[]> = {
  debug: ['error', 'bug', 'fail', 'crash', 'broken', 'fix', 'issue', 'exception', 'trace', 'wrong', 'unexpected'],
  implement: ['add', 'create', 'build', 'implement', 'write', 'make', 'new', 'feature', 'support'],
  explain: ['how', 'why', 'what', 'explain', 'understand', 'describe', 'meaning', 'purpose', 'does'],
  code_search: ['where', 'find', 'locate', 'search', 'show', 'grep', 'file', 'function', 'class', 'module'],
  general: [],
};

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

/** Create a retrieval plan from a query */
export function planQuery(query: string): QueryPlan {
  const intent = detectIntent(query);
  const expandedTerms = expandQuery(query);

  // All intents default to vector-only retrieval.
  // Ablation testing showed vector-only with strong embeddings (GTE-ModernBERT)
  // beats hybrid (vector+FTS5+graph) on all metrics: R@10 +7.5%, NDCG +16.8%, MRR +18.9%.
  // Graph traversal degrades NDCG/MRR by ~22% across all models.
  switch (intent) {
    case 'debug':
      return {
        intent,
        expandedTerms,
        strategy: 'vector',
        maxHops: 0,
        tokenBudgetRatio: 0.6,
      };
    case 'implement':
      return {
        intent,
        expandedTerms,
        strategy: 'vector',
        maxHops: 0,
        tokenBudgetRatio: 0.4,
      };
    case 'explain':
      return {
        intent,
        expandedTerms,
        strategy: 'vector',
        maxHops: 0,
        tokenBudgetRatio: 0.3,
      };
    case 'code_search':
      return {
        intent,
        expandedTerms,
        strategy: 'vector',
        maxHops: 0,
        tokenBudgetRatio: 0.35,
      };
    default:
      return {
        intent,
        expandedTerms,
        strategy: 'vector',
        maxHops: 0,
        tokenBudgetRatio: 0.5,
      };
  }
}
