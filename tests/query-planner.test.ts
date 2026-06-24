import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectIntent,
  expandQuery,
  estimateComplexity,
  parseStructuralQuery,
  planQuery,
  getAdaptiveStrategy,
  adaptiveTopK,
} from '../src/core/query-planner.js';

describe('detectIntent', () => {
  it('detects mutation terms as implement', () => {
    expect(detectIntent('add a new feature for authentication')).toBe('implement');
    expect(detectIntent('create the user module')).toBe('implement');
    expect(detectIntent('build a REST API endpoint')).toBe('implement');
    expect(detectIntent('implement JWT validation')).toBe('implement');
    expect(detectIntent('write a unit test')).toBe('implement');
    expect(detectIntent('update the config file')).toBe('implement');
    expect(detectIntent('modify the login handler')).toBe('implement');
    expect(detectIntent('change the routing logic')).toBe('implement');
  });

  it('detects lookup openings as code_search', () => {
    expect(detectIntent('where is the login handler defined')).toBe('code_search');
    expect(detectIntent('find the authentication middleware')).toBe('code_search');
    expect(detectIntent('locate the database connection')).toBe('code_search');
    expect(detectIntent('show the user model')).toBe('code_search');
    expect(detectIntent('grep for all TODO comments')).toBe('code_search');
  });

  it('detects debug keywords', () => {
    expect(detectIntent('fix the error in login.ts')).toBe('debug');
    expect(detectIntent('there is a bug in the auth flow')).toBe('debug');
    expect(detectIntent('the test fails with an exception')).toBe('debug');
    expect(detectIntent('unexpected crash when loading')).toBe('debug');
  });

  it('detects explain keywords', () => {
    expect(detectIntent('how does the scoring work')).toBe('explain');
    expect(detectIntent('why is the routing slow')).toBe('explain');
    expect(detectIntent('what does the middleware do')).toBe('explain');
    expect(detectIntent('explain the retrieval pipeline')).toBe('explain');
  });

  it('returns general for ambiguous input', () => {
    expect(detectIntent('authentication system')).toBe('general');
    expect(detectIntent('performance metrics')).toBe('general');
  });

  it('prefers implement when query contains mutation terms even with other keywords', () => {
    // "add" is a mutation term; "add" also matches debug's "add" or code_search's "add"
    // but mutation terms are checked first (LOOKUP_OPENING is checked before MUTATION_TERMS)
    expect(detectIntent('add error handling')).toBe('implement');
  });

  it('detects code_search with "which file" opening', () => {
    expect(detectIntent('which file contains the main function')).toBe('code_search');
  });

  it('classifies "add support for X" as implement', () => {
    expect(detectIntent('add support for OpenAI embeddings')).toBe('implement');
    expect(detectIntent('add support for custom scoring')).toBe('implement');
  });
});

describe('expandQuery', () => {
  it('removes stop words', () => {
    const terms = expandQuery('the quick brown fox is running');
    // "the", "is" are stop words; "running" is not a stop word
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('is');
    expect(terms).toContain('quick');
    expect(terms).toContain('brown');
    expect(terms).toContain('fox');
    expect(terms).toContain('running');
  });

  it('filters short words (length <= 2)', () => {
    const terms = expandQuery('a big number in the app');
    expect(terms).not.toContain('a');
    expect(terms).not.toContain('in');
    expect(terms).toContain('big');
    expect(terms).toContain('number');
    expect(terms).toContain('app');
  });

  it('deduplicates terms while preserving order', () => {
    const terms = expandQuery('scoring scoring scoring module module');
    expect(terms).toEqual(['scoring', 'module']);
  });

  it('strips punctuation', () => {
    const terms = expandQuery('find the auth.module, please');
    // "find", "please" are stop words; punctuation stripped
    expect(terms).toContain('auth');
    expect(terms).toContain('module');
  });

  it('returns empty array for stop-word-only input', () => {
    const terms = expandQuery('the a is of it');
    expect(terms).toEqual([]);
  });
});

describe('estimateComplexity', () => {
  it('detects broad queries with broadening terms', () => {
    expect(estimateComplexity('show all the entire architecture overview', ['show', 'all', 'entire', 'architecture', 'overview'])).toBe('broad');
  });

  it('detects narrow queries with path patterns and narrowing terms', () => {
    expect(estimateComplexity('fix the specific bug in src/auth/login.ts', ['fix', 'specific', 'bug', 'src', 'auth', 'login'])).toBe('narrow');
  });

  it('detects narrow queries with only specific terms', () => {
    expect(estimateComplexity('just this exact function only', ['just', 'exact', 'function'])).toBe('narrow');
  });

  it('returns moderate for neutral queries', () => {
    expect(estimateComplexity('authentication module', ['authentication', 'module'])).toBe('moderate');
  });

  it('detects narrow for short queries with path patterns', () => {
    // termCount=1 + path pattern gives narrowSignals=3 (1 from termCount + 2 from path)
    expect(estimateComplexity('login.ts', ['login'])).toBe('narrow');
  });

  it('detects narrow for queries with file extensions', () => {
    expect(estimateComplexity('find the handler in utils.ts', ['find', 'handler', 'utils'])).toBe('narrow');
  });

  it('detects narrow for queries with function call syntax and path', () => {
    // function call pattern gives narrowSignals=1, path pattern gives +2, total=3 > 0+1
    expect(estimateComplexity('find the call to authenticate() in src/auth.ts', ['find', 'call', 'authenticate', 'src', 'auth'])).toBe('narrow');
  });

  it('detects narrow for queries with snake_case identifiers and narrowing terms', () => {
    // snake_case gives narrowSignals=1, "specific" gives +1, total=2 > 0+1
    expect(estimateComplexity('fix the specific get_user_by_id function', ['fix', 'specific', 'get', 'user', 'id', 'function'])).toBe('narrow');
  });
});

describe('parseStructuralQuery', () => {
  it('extracts quoted terms', () => {
    const result = parseStructuralQuery('find "authenticateUser" in the code');
    expect(result.quotedTerms).toContain('authenticateuser');
  });

  it('extracts single-quoted terms', () => {
    const result = parseStructuralQuery("find 'loginHandler' definition");
    expect(result.quotedTerms).toContain('loginhandler');
  });

  it('extracts path fragments', () => {
    const result = parseStructuralQuery('find code in src/core/scorer.ts');
    expect(result.pathFragments).toContainEqual(expect.stringContaining('src/core/scorer.ts'));
  });

  it('extracts file extensions', () => {
    const result = parseStructuralQuery('find all .ts and .py files');
    expect(result.extensions).toContain('ts');
    expect(result.extensions).toContain('py');
  });

  it('extracts and normalizes identifiers', () => {
    const result = parseStructuralQuery('find the authenticateUser function');
    expect(result.identifiers).toContain('authenticateUser');
  });

  it('splits camelCase identifiers into parts', () => {
    const result = parseStructuralQuery('find authenticateUser');
    // splitIdentifier should split 'authenticateUser' into ['authenticate', 'user']
    expect(result.identifierParts).toContain('authenticate');
    expect(result.identifierParts).toContain('user');
  });

  it('produces normalized identifiers', () => {
    const result = parseStructuralQuery('find authenticateUser');
    expect(result.normalizedIdentifiers).toContain('authenticateuser');
  });

  it('stores raw query', () => {
    const query = 'find the authenticate middleware';
    const result = parseStructuralQuery(query);
    expect(result.raw).toBe(query);
  });

  it('extracts tokens matching expandQuery', () => {
    const result = parseStructuralQuery('fix the login handler');
    // "fix" is a stop word, so tokens are ['login', 'handler']
    expect(result.tokens).toEqual(expect.arrayContaining(['login', 'handler']));
  });

  it('deduplicates path fragments when same fragment appears', () => {
    // "src/core/scorer.ts src/core/scorer.ts" — duplicate fragments are deduped
    const result = parseStructuralQuery('src/core/scorer.ts src/core/scorer.ts');
    const scorerTsCount = result.pathFragments.filter((p) => p === 'src/core/scorer.ts').length;
    expect(scorerTsCount).toBe(1);
  });

  it('extracts standalone file with extension as path fragment', () => {
    const result = parseStructuralQuery('look at budget.ts');
    expect(result.pathFragments).toContain('budget.ts');
  });

  it('extracts src/core/retriever.ts as path fragment with tokens', () => {
    const result = parseStructuralQuery('find the retrieve logic in src/core/retriever.ts');
    expect(result.pathFragments).toContain('src/core/retriever.ts');
    expect(result.extensions).toContain('ts');
    expect(result.pathTokens).toContain('src');
    expect(result.pathTokens).toContain('core');
    expect(result.pathTokens).toContain('retriever');
  });

  it('splits SQLiteRepository into useful parts', () => {
    const result = parseStructuralQuery('find the SQLiteRepository class');
    expect(result.identifiers).toContain('SQLiteRepository');
    expect(result.identifierParts).toContain('sqlite');
    expect(result.identifierParts).toContain('repository');
    expect(result.normalizedIdentifiers).toContain('sqliterepository');
  });

  it('splits retrieve_context snake_case into useful parts', () => {
    const result = parseStructuralQuery('where is retrieve_context defined');
    expect(result.identifiers).toContain('retrieve_context');
    expect(result.identifierParts).toContain('retrieve');
    expect(result.identifierParts).toContain('context');
    expect(result.normalizedIdentifiers).toContain('retrieve_context');
  });
});

describe('planQuery', () => {
  it('returns a valid QueryPlan with all fields', () => {
    const plan = planQuery('fix the authentication error in login.ts');

    expect(plan).toHaveProperty('intent');
    expect(plan).toHaveProperty('expandedTerms');
    expect(plan).toHaveProperty('strategy');
    expect(plan).toHaveProperty('maxHops');
    expect(plan).toHaveProperty('tokenBudgetRatio');
    expect(plan).toHaveProperty('complexity');
    expect(plan).toHaveProperty('structuralQuery');
    expect(plan).toHaveProperty('recommendedTopK');

    expect(typeof plan.intent).toBe('string');
    expect(Array.isArray(plan.expandedTerms)).toBe(true);
    expect(typeof plan.strategy).toBe('string');
    expect(typeof plan.maxHops).toBe('number');
    expect(typeof plan.tokenBudgetRatio).toBe('number');
    expect(['narrow', 'moderate', 'broad']).toContain(plan.complexity);
    expect(typeof plan.recommendedTopK).toBe('number');
    expect(plan.structuralQuery).toHaveProperty('raw');
  });

  it('produces consistent intent for debug queries', () => {
    const plan = planQuery('fix the error in the login handler');
    expect(plan.intent).toBe('debug');
  });

  it('produces narrow complexity for path-specific queries', () => {
    const plan = planQuery('find the bug in src/auth/login.ts');
    expect(plan.complexity).toBe('narrow');
  });

  it('sets tokenBudgetRatio between 0 and 1', () => {
    const plan = planQuery('explain the system architecture');
    expect(plan.tokenBudgetRatio).toBeGreaterThan(0);
    expect(plan.tokenBudgetRatio).toBeLessThanOrEqual(0.8);
  });
});

describe('getAdaptiveStrategy', () => {
  const originalEnv = process.env.EMBEDDING_PROVIDER;

  beforeEach(() => {
    delete process.env.EMBEDDING_PROVIDER;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.EMBEDDING_PROVIDER = originalEnv;
    } else {
      delete process.env.EMBEDDING_PROVIDER;
    }
  });

  it('returns hybrid for local provider (default)', () => {
    expect(getAdaptiveStrategy()).toBe('hybrid');
  });

  it('returns structural (calibrated hybrid) for gpu provider', () => {
    // The honest commit-derived GPU data shows the calibrated structural hybrid
    // dominates vector-only on both recall and top-1; the old gpu→vector route
    // rested on the retired contaminated ablation. See getAdaptiveStrategy.
    process.env.EMBEDDING_PROVIDER = 'gpu';
    expect(getAdaptiveStrategy()).toBe('structural');
  });

  it('returns text for deterministic provider', () => {
    process.env.EMBEDDING_PROVIDER = 'deterministic';
    expect(getAdaptiveStrategy()).toBe('text');
  });

  it('returns hybrid for local provider explicitly', () => {
    process.env.EMBEDDING_PROVIDER = 'local';
    expect(getAdaptiveStrategy()).toBe('hybrid');
  });

  it('returns hybrid for unknown provider (fallback)', () => {
    process.env.EMBEDDING_PROVIDER = 'unknown';
    expect(getAdaptiveStrategy()).toBe('hybrid');
  });
});

describe('adaptiveTopK', () => {
  it('returns 15 for broad complexity', () => {
    expect(adaptiveTopK('general', 'broad')).toBe(15);
    expect(adaptiveTopK('debug', 'broad')).toBe(15);
    expect(adaptiveTopK('explain', 'broad')).toBe(15);
  });

  it('returns 5 for narrow complexity', () => {
    expect(adaptiveTopK('general', 'narrow')).toBe(5);
    expect(adaptiveTopK('explain', 'narrow')).toBe(5);
  });

  it('returns 5 for code_search intent with narrow and moderate complexity', () => {
    expect(adaptiveTopK('code_search', 'narrow')).toBe(5);
    expect(adaptiveTopK('code_search', 'moderate')).toBe(5);
  });

  it('returns 15 for code_search intent with broad complexity', () => {
    // broad complexity is checked first in adaptiveTopK
    expect(adaptiveTopK('code_search', 'broad')).toBe(15);
  });

  it('returns 10 for debug/implement/explain with moderate complexity', () => {
    expect(adaptiveTopK('debug', 'moderate')).toBe(10);
    expect(adaptiveTopK('implement', 'moderate')).toBe(10);
    expect(adaptiveTopK('explain', 'moderate')).toBe(10);
  });

  it('returns 8 for general intent with moderate complexity', () => {
    expect(adaptiveTopK('general', 'moderate')).toBe(8);
  });
});
