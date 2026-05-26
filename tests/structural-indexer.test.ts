import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepository } from '../src/storage/repository.js';
import {
  StructuralIndexer,
  extractStructureFallback,
  normalizeIdentifier,
} from '../src/providers/structural-indexer.js';
import { parseStructuralQuery } from '../src/core/query-planner.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { ContextScorer } from '../src/core/scorer.js';
import { ContextRouter, DEFAULT_ROUTING_CONFIG } from '../src/core/router.js';
import { ContextIngester } from '../src/core/ingester.js';
import { DeterministicTokenEstimator } from '../src/providers/token-estimator.js';
import { DeterministicEmbeddingProvider } from '../src/providers/deterministic-embedding.js';
import { DeterministicCompressionProvider } from '../src/providers/deterministic-compression.js';
import { SimpleDependencyAnalyzer } from '../src/providers/dependency-analyzer.js';

let dbCounter = 0;
const dbPaths: string[] = [];
const originalDisableAst = process.env.SPACEFOLDING_DISABLE_AST_SUBPROCESS;

function testDbPath(): string {
  dbCounter++;
  const path = join(tmpdir(), `spacefolding-structural-${Date.now()}-${dbCounter}.db`);
  dbPaths.push(path);
  return path;
}

function createTestPipeline(): PipelineOrchestrator {
  const storage = createRepository(testDbPath());
  const tokenEstimator = new DeterministicTokenEstimator();
  const embeddingProvider = new DeterministicEmbeddingProvider();
  return new PipelineOrchestrator(
    storage,
    new ContextScorer(DEFAULT_ROUTING_CONFIG, embeddingProvider, tokenEstimator),
    new ContextRouter(DEFAULT_ROUTING_CONFIG),
    new DeterministicCompressionProvider(),
    new SimpleDependencyAnalyzer(),
    new ContextIngester(tokenEstimator),
    embeddingProvider
  );
}

beforeEach(() => {
  process.env.SPACEFOLDING_DISABLE_AST_SUBPROCESS = '1';
});

afterEach(() => {
  if (originalDisableAst === undefined) {
    delete process.env.SPACEFOLDING_DISABLE_AST_SUBPROCESS;
  } else {
    process.env.SPACEFOLDING_DISABLE_AST_SUBPROCESS = originalDisableAst;
  }
});

afterAll(() => {
  for (const path of dbPaths) {
    if (existsSync(path)) unlinkSync(path);
  }
});

describe('structural extraction fallback', () => {
  it('extracts TypeScript symbols and imports', () => {
    const result = extractStructureFallback(
      "import { Router } from './router';\nexport function authenticate(token: string) {\n  return token;\n}\nclass LoginService {}",
      'typescript',
      'src/auth/login.ts'
    );
    expect(result.symbols.map((s) => [s.kind, s.name])).toEqual([
      ['function', 'authenticate'],
      ['class', 'LoginService'],
    ]);
    expect(result.references[0].target).toBe('./router');
  });

  it('extracts exported TypeScript symbols, methods, normalized imports, and calls', () => {
    const result = extractStructureFallback(
      [
        "import { verifyToken } from './AuthTokens';",
        'export function authenticate(token: Token): Result {',
        '  return verifyToken(token);',
        '}',
        'class LoginService extends BaseService implements AuthService {',
        '  public login(user: User) {',
        '    return authenticate(user.token);',
        '  }',
        '}',
        "export { LoginService as Service } from './services';",
      ].join('\n'),
      'typescript',
      'src/auth/login.ts'
    );

    expect(result.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'authenticate',
        kind: 'function',
        isExported: true,
        normalizedName: 'authenticate',
      }),
      expect.objectContaining({ name: 'login', kind: 'method' }),
    ]));

    expect(result.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'import',
        target: './AuthTokens',
        normalizedTarget: normalizeIdentifier('./AuthTokens'),
      }),
      expect.objectContaining({ kind: 'export', target: 'authenticate' }),
      expect.objectContaining({ kind: 'call', target: 'verifyToken' }),
      expect.objectContaining({ kind: 'inheritance', target: 'BaseService' }),
      expect.objectContaining({ kind: 'inheritance', target: 'AuthService' }),
    ]));
  });

  it('does not index local TypeScript variables as structural symbols', () => {
    const result = extractStructureFallback(
      [
        'export function summarizeChunks() {',
        '  const chunk = { count: 1 };',
        '  return chunk.count;',
        '}',
        'const topLevelHelper = () => true;',
      ].join('\n'),
      'typescript',
      'src/summary.ts'
    );

    expect(result.symbols.map((symbol) => [symbol.kind, symbol.name])).toEqual([
      ['function', 'summarizeChunks'],
      ['function', 'topLevelHelper'],
    ]);
  });

  it('extracts JavaScript CommonJS references', () => {
    const result = extractStructureFallback(
      "const api = require('./api');\nmodule.exports = function createServer() {}",
      'javascript',
      'server.js'
    );
    expect(result.references.map((r) => r.target)).toContain('./api');
  });

  it('extracts Python symbols and imports', () => {
    const result = extractStructureFallback(
      'from auth.tokens import verify\nclass LoginService:\n    pass\n\ndef authenticate(token):\n    return verify(token)\n',
      'python',
      'auth/login.py'
    );
    expect(result.symbols.map((s) => s.name)).toEqual(['LoginService', 'authenticate']);
    expect(result.references[0].target).toBe('auth.tokens');
  });

  it('extracts Rust symbols and uses', () => {
    const result = extractStructureFallback(
      'use crate::auth::Token;\npub struct LoginService {}\npub fn authenticate(token: Token) -> bool { true }\n',
      'rust',
      'src/auth.rs'
    );
    expect(result.symbols.map((s) => [s.kind, s.name])).toEqual([
      ['struct', 'LoginService'],
      ['function', 'authenticate'],
    ]);
    expect(result.references[0].target).toBe('crate::auth::Token');
  });

  it('extracts Go symbols and imports', () => {
    const result = extractStructureFallback(
      'package auth\n\nimport "context"\n\ntype LoginService struct {}\nfunc Authenticate(ctx context.Context) bool { return true }\n',
      'go',
      'auth/login.go'
    );
    expect(result.symbols.map((s) => s.name)).toEqual(['LoginService', 'Authenticate']);
    expect(result.references[0].target).toBe('context');
  });

  it('extracts Java symbols and imports', () => {
    const result = extractStructureFallback(
      'import com.example.Token;\npublic class LoginService {\n  public boolean authenticate(Token token) { return true; }\n}\n',
      'java',
      'src/LoginService.java'
    );
    expect(result.symbols.map((s) => [s.kind, s.name])).toEqual([
      ['class', 'LoginService'],
      ['method', 'authenticate'],
    ]);
    expect(result.references[0].target).toBe('com.example.Token');
  });

  it('returns no symbols for empty, malformed, or unsupported source without throwing', () => {
    expect(extractStructureFallback('', 'typescript').symbols).toEqual([]);
    expect(() => extractStructureFallback('export function ( {', 'typescript')).not.toThrow();
    expect(extractStructureFallback('export function ( {', 'typescript').symbols).toEqual([]);
    expect(extractStructureFallback('export function authenticate() {}', 'markdown').symbols).toEqual([]);
  });

  it('degrades unsupported languages through the StructuralIndexer without throwing', async () => {
    const indexer = new StructuralIndexer({ disableSubprocess: true });

    await expect(indexer.extract('export function authenticate() {}', 'markdown', 'docs/auth.md'))
      .resolves.toEqual({
        symbols: [],
        references: [],
        backend: 'regex-fallback',
      });
  });
});

describe('structural index repository', () => {
  it('persists, replaces, and cascades code symbols and references', () => {
    const repo = createRepository(testDbPath());
    const chunk = {
      id: 'chunk-1',
      source: 'file',
      type: 'code' as const,
      text: 'export function authenticate() {}',
      timestamp: Date.now(),
      path: 'src/auth/login.ts',
      language: 'typescript',
      tokensEstimate: 5,
      childrenIds: [],
      metadata: {},
    };
    repo.storeChunk(chunk);

    const first = extractStructureFallback(chunk.text, chunk.language, chunk.path);
    repo.storeCodeStructure(chunk.id, first.symbols, first.references);
    expect(repo.getCodeSymbols(chunk.id).map((s) => s.name)).toEqual(['authenticate']);

    const second = extractStructureFallback('export class LoginService {}', chunk.language, chunk.path);
    repo.storeCodeStructure(chunk.id, second.symbols, second.references);
    expect(repo.getCodeSymbols(chunk.id).map((s) => s.name)).toEqual(['LoginService']);

    repo.deleteChunk(chunk.id);
    expect(repo.getCodeSymbols(chunk.id)).toEqual([]);
    repo.close();
  });

  it('prioritizes exact path, symbol, and reference matches in structural search', () => {
    const repo = createRepository(testDbPath());
    const now = Date.now();
    for (const chunk of [
      {
        id: 'exact-path',
        source: 'file',
        type: 'code' as const,
        text: 'export class HybridRetriever {}',
        timestamp: now,
        path: 'src/core/retriever.ts',
        language: 'typescript',
        tokensEstimate: 20,
        childrenIds: [],
        metadata: {},
      },
      {
        id: 'same-filename',
        source: 'file',
        type: 'code' as const,
        text: 'export class LegacyRetriever {}',
        timestamp: now,
        path: 'src/legacy/retriever.ts',
        language: 'typescript',
        tokensEstimate: 20,
        childrenIds: [],
        metadata: {},
      },
      {
        id: 'repository',
        source: 'file',
        type: 'code' as const,
        text: 'export class SQLiteRepository {}',
        timestamp: now,
        path: 'src/storage/repository.ts',
        language: 'typescript',
        tokensEstimate: 20,
        childrenIds: [],
        metadata: {},
      },
      {
        id: 'consumer',
        source: 'file',
        type: 'code' as const,
        text: 'const repo: RepositoryContract = createRepository();',
        timestamp: now,
        path: 'src/core/consumer.ts',
        language: 'typescript',
        tokensEstimate: 20,
        childrenIds: [],
        metadata: {},
      },
    ]) {
      repo.storeChunk(chunk);
    }
    repo.storeCodeStructure('repository', [
      {
        id: 'repository:SQLiteRepository',
        chunkId: 'repository',
        path: 'src/storage/repository.ts',
        language: 'typescript',
        name: 'SQLiteRepository',
        normalizedName: 'sqliterepository',
        kind: 'class',
        signature: 'SQLiteRepository',
        startLine: 1,
        endLine: 1,
        isExported: true,
        metadata: {},
      },
    ], []);
    repo.storeCodeStructure('consumer', [], [
      {
        id: 'consumer:RepositoryContract',
        chunkId: 'consumer',
        path: 'src/core/consumer.ts',
        language: 'typescript',
        target: 'RepositoryContract',
        normalizedTarget: 'repositorycontract',
        kind: 'import',
        startLine: 1,
        endLine: 1,
        metadata: {},
      },
    ]);

    const pathResults = repo.searchByStructure(parseStructuralQuery('src/core/retriever.ts'), 5);
    expect(pathResults[0].chunkId).toBe('exact-path');
    expect(pathResults[0].reasons).toContain('path exact match: src/core/retriever.ts');

    const symbolResults = repo.searchByStructure(parseStructuralQuery('SQLiteRepository'), 5);
    expect(symbolResults[0].chunkId).toBe('repository');
    expect(symbolResults[0].reasons.some((reason) =>
      reason === 'symbol exact match: SQLiteRepository'
      || reason === 'symbol strong exact match: SQLiteRepository'
    )).toBe(true);

    const referenceResults = repo.searchByStructure(parseStructuralQuery('RepositoryContract'), 5);
    expect(referenceResults[0].chunkId).toBe('consumer');
    expect(referenceResults[0].reasons.some((reason) =>
      reason === 'direct reference exact match: RepositoryContract'
      || reason === 'direct reference strong exact match: RepositoryContract'
    )).toBe(true);
    expect(referenceResults[0].dependencyBoost).toBeGreaterThan(0);
    repo.close();
  });
});

describe('structural retrieval integration', () => {
  it('keeps duplicate file contents at different paths', async () => {
    const pipeline = createTestPipeline();
    const content = 'export function sharedHelper() { return true; }';
    const first = await pipeline.ingest('file', content, 'code', 'src/a/shared.ts', 'typescript');
    const second = await pipeline.ingest('file', content, 'code', 'src/b/shared.ts', 'typescript');
    expect(first.id).not.toBe(second.id);
    expect(pipeline.getAllChunks().filter((chunk) => chunk.path?.endsWith('shared.ts'))).toHaveLength(2);
    pipeline.close();
  });

  it('ranks structural symbol matches above unrelated lexical matches', async () => {
    const pipeline = createTestPipeline();
    await pipeline.ingest(
      'file',
      'export function authenticate(token: string) { return token.length > 0; }',
      'code',
      'src/auth/login.ts',
      'typescript'
    );
    await pipeline.ingest(
      'file',
      '// authenticate authenticate authenticate\nexport function unrelated() { return false; }',
      'code',
      'src/noise/comments.ts',
      'typescript'
    );

    const result = await pipeline.retrieve('find authenticate implementation', 10_000, {
      strategy: 'structural',
      topK: 5,
    });

    expect(result.chunks[0].path).toBe('src/auth/login.ts');
    expect(result.retrieval[0].sources).toContain('structural');
    pipeline.close();
  });

  it('ranks exact local declarations for contains-file lookup queries', async () => {
    const pipeline = createTestPipeline();
    await pipeline.ingest(
      'file',
      [
        'function parseAtom(block: string) {',
        "  const title = (extractTag(block, 'title') ?? '').trim();",
        '  return { title };',
        '}',
      ].join('\n'),
      'code',
      'src/connectors/arxiv.ts',
      'typescript'
    );
    await pipeline.ingest(
      'file',
      [
        'export interface Task {',
        '  title: string;',
        '}',
        'export function render(task: Task) {',
        '  return `${task.title} ${task.title}`;',
        '}',
      ].join('\n'),
      'code',
      'src/supervisor/tasks.ts',
      'typescript'
    );

    const result = await pipeline.retrieve('which file contains title', 10_000, {
      strategy: 'structural',
      mode: 'exhaustive',
      topK: 5,
    });

    expect(result.chunks[0].path).toBe('src/connectors/arxiv.ts');
    expect(result.retrieval[0].reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('sparse exact identifier declaration: title'),
    ]));
    pipeline.close();
  });
});
