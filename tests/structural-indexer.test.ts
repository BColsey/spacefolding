import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepository } from '../src/storage/repository.js';
import { extractStructureFallback } from '../src/providers/structural-indexer.js';
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
});
