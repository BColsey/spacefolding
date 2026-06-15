import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ablateSymbols,
  buildCommitDataset,
  buildQuery,
  classifyIntent,
  extractDefinedSymbols,
  isCodeShaped,
  messageNamesAnyFile,
  messageNamesFile,
  parseArgs,
  validateCommitOutputPath,
  type CliOptions,
  type RawCommit,
} from '../benchmarks/generate-commit-tasks.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function options(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    repo: projectRoot,
    output: join(tmpdir(), 'spacefolding-commit-test.json'),
    maxCommits: 200,
    limit: 100,
    minFiles: 1,
    maxFiles: 5,
    includeTests: false,
    includeMerges: false,
    seed: 'test',
    ...overrides,
  };
}

describe('commit-task generator — CLI parsing', () => {
  it('defaults output to a /tmp artifact and the repo to the project root', () => {
    const parsed = parseArgs([]);
    expect(parsed.output.startsWith(`${tmpdir()}`) || parsed.output.startsWith('/tmp')).toBe(true);
    expect(resolve(parsed.repo)).toBe(projectRoot);
  });

  it('rejects min-files greater than max-files', () => {
    expect(() => parseArgs(['--min-files', '6', '--max-files', '3'])).toThrow(
      '--min-files must not exceed --max-files'
    );
  });

  it('rejects invalid numeric options and unknown flags', () => {
    expect(() => parseArgs(['--limit', '0'])).toThrow('--limit must be a positive integer');
    expect(() => parseArgs(['--max-commits', '1.5'])).toThrow('--max-commits must be a positive integer');
    expect(() => parseArgs(['--nope'])).toThrow('Unknown argument: --nope');
    expect(() => parseArgs(['--repo'])).toThrow('--repo requires a value');
  });
});

describe('commit-task generator — output path safety', () => {
  it('accepts a plain /tmp path', () => {
    expect(() => validateCommitOutputPath(join(tmpdir(), 'ok.json'))).not.toThrow();
  });

  it('refuses to write inside the repository checkout', () => {
    expect(() => validateCommitOutputPath(join(projectRoot, 'benchmarks', 'leak.json'))).toThrow(
      /inside the repository/
    );
  });

  it('refuses to write outside /tmp', () => {
    expect(() => validateCommitOutputPath(join(projectRoot, '..', 'elsewhere.json'))).toThrow(
      /(inside the repository|outside \/tmp)/
    );
  });
});

describe('anti-leakage: messageNamesFile', () => {
  it('flags a message that names the file with its extension', () => {
    expect(messageNamesFile('Fix NPE in retriever.ts on empty query', 'src/core/retriever.ts')).toBe(true);
  });

  it('flags a message that names the full path', () => {
    expect(messageNamesFile('Refactor src/core/scorer.ts weighting', 'src/core/scorer.ts')).toBe(true);
  });

  it('flags a distinctive (code-shaped) basename even without the extension', () => {
    expect(messageNamesFile('tweak tokenStore eviction', 'src/storage/tokenStore.ts')).toBe(true);
  });

  it('does NOT flag a class name that is not the filename', () => {
    // Naming the HybridRetriever class is not naming retriever.ts — that case is
    // handled by the symbol-removed ablation, not by anti-leakage exclusion.
    expect(messageNamesFile('Speed up HybridRetriever fusion', 'src/core/retriever.ts')).toBe(false);
  });

  it('does NOT flag a plain-word basename mentioned as ordinary prose', () => {
    expect(messageNamesFile('update the data models for new schema', 'app/db/models.py')).toBe(false);
    // ...but the same word WITH the extension is a real leak.
    expect(messageNamesFile('update models.py for new schema', 'app/db/models.py')).toBe(true);
  });

  it('messageNamesAnyFile flags when any one file is named', () => {
    expect(
      messageNamesAnyFile('Fix retriever.ts crash', ['src/core/scorer.ts', 'src/core/retriever.ts'])
    ).toBe(true);
    expect(
      messageNamesAnyFile('General cleanup of fusion code', ['src/core/scorer.ts', 'src/core/retriever.ts'])
    ).toBe(false);
  });
});

describe('intent classification', () => {
  it('maps conventional and natural messages to intents', () => {
    expect(classifyIntent('fix: crash when query is empty')).toBe('debug');
    expect(classifyIntent('Fix a regression in routing')).toBe('debug');
    expect(classifyIntent('feat: add OpenAI embedding provider')).toBe('implement');
    expect(classifyIntent('Implement streaming responses')).toBe('implement');
    expect(classifyIntent('refactor: rename internal helpers')).toBe('explain');
    expect(classifyIntent('docs: document the scoring weights')).toBe('explain');
    expect(classifyIntent('Align retrieval terminology across modules')).toBe('code_search');
  });
});

describe('query construction', () => {
  it('strips the conventional-commit prefix and keeps the first paragraph', () => {
    const q = buildQuery('fix(retriever): wrong fusion order', 'The lexical and vector scores were combined on incompatible scales.\n\nSecond paragraph ignored.');
    expect(q).toContain('wrong fusion order');
    expect(q).toContain('incompatible scales');
    expect(q).not.toContain('fix(retriever)');
    expect(q).not.toContain('Second paragraph');
  });

  it('drops trailer lines and caps length', () => {
    const long = 'x'.repeat(500);
    const q = buildQuery('Add caching layer', `Real description here.\nSigned-off-by: Someone <a@b.c>\nCloses #123`);
    expect(q).toContain('Real description here');
    expect(q).not.toMatch(/signed-off-by/i);
    expect(q).not.toContain('Closes #123');
    expect(buildQuery('Subject', long).length).toBeLessThanOrEqual(321);
  });

  it('does not produce a doubled sentence terminator when the subject already ends with one', () => {
    expect(buildQuery('Fixed equality bug.', 'Edge cases were missed.')).not.toContain('..');
    expect(buildQuery('Why does X fail?', 'It races on startup.')).toContain('fail? It races');
  });
});

describe('code-shape heuristic', () => {
  it('recognises identifier-shaped tokens', () => {
    for (const t of ['tokenStore', 'snake_case', 'HybridRetriever', 'sha256', 'topK']) {
      expect(isCodeShaped(t)).toBe(true);
    }
  });
  it('rejects ordinary words', () => {
    for (const t of ['retriever', 'models', 'scoring', 'the', 'data']) {
      expect(isCodeShaped(t)).toBe(false);
    }
  });
});

describe('symbol-removed ablation', () => {
  it('neutralises defined symbols, backticked code, and code-shaped tokens, but keeps prose', () => {
    const defined = new Map<string, string>([
      ['fillBudget', 'function'],
      ['HybridRetriever', 'class'],
    ]);
    const { text, removed } = ablateSymbols(
      'Fix fillBudget so the HybridRetriever respects `maxTokens` when scoring',
      defined
    );
    expect(removed).toEqual(expect.arrayContaining(['fillBudget', 'HybridRetriever', 'maxTokens']));
    expect(text).not.toContain('fillBudget');
    expect(text).not.toContain('HybridRetriever');
    expect(text).not.toContain('maxTokens');
    expect(text).not.toContain('`'); // backticks removed
    expect(text).toContain('scoring'); // ordinary prose retained
    expect(text).toContain('the relevant function'); // function placeholder
    expect(text).toContain('the relevant component'); // class placeholder
  });

  it('is a no-op (empty removed list, unchanged text) when no identifiers are present', () => {
    const { text, removed } = ablateSymbols('improve error messages for empty queries', new Map());
    expect(removed).toEqual([]);
    expect(text).toBe('improve error messages for empty queries');
  });
});

describe('defined-symbol extraction reads real source', () => {
  it('finds an exported class in retriever.ts', () => {
    const symbols = extractDefinedSymbols([join(projectRoot, 'src/core/retriever.ts')]);
    expect(symbols.get('HybridRetriever')).toBe('class');
  });
});

describe('buildCommitDataset with injected commits (no git)', () => {
  const commits: RawCommit[] = [
    {
      hash: 'aaaa111',
      subject: 'Improve fusion weighting in the hybrid scorer',
      body: 'The lexical and vector scores were combined on incompatible scales.',
      files: ['src/core/retriever.ts', 'src/core/scorer.ts'],
    },
    {
      hash: 'bbbb222',
      subject: 'Fix crash in retriever.ts on empty query', // names the file -> leak
      body: '',
      files: ['src/core/retriever.ts'],
    },
    {
      hash: 'cccc333',
      subject: 'Update the project README and add a logo', // no code files
      body: '',
      files: ['README.md', 'src/core/does-not-exist.ts'], // non-code + nonexistent
    },
    {
      hash: 'dddd444',
      subject: 'Adjust the unit test for the scorer',
      body: '',
      files: ['tests/scorer.test.ts'], // test path, excluded by default
    },
  ];

  it('keeps only the clean task and reports honest exclusion counters', () => {
    const { dataset, summary } = buildCommitDataset(options(), commits);

    expect(summary.tasks).toBe(1);
    expect(summary.excludedNamedFile).toBe(1); // bbbb222
    expect(summary.excludedNoCodeFiles).toBeGreaterThanOrEqual(2); // cccc333 + dddd444

    const task = dataset.tasks[0];
    expect(task.id).toBe('C001');
    expect(task.source).toBe('commit-derived');
    expect(task.commit.hash).toBe('aaaa111');
    expect(task.relevant_files).toEqual(['src/core/retriever.ts', 'src/core/scorer.ts']);
    expect(task.relevant_files.every((p) => existsSync(join(projectRoot, p)))).toBe(true);
  });

  it('emits a schema compatible with evaluate.ts and e2e-benchmark.ts', () => {
    const { dataset } = buildCommitDataset(options(), commits);
    for (const task of dataset.tasks) {
      expect(typeof task.id).toBe('string');
      expect(typeof task.task).toBe('string');
      expect(task.task.length).toBeGreaterThan(0);
      expect(['code_search', 'debug', 'explain', 'implement']).toContain(task.intent);
      expect(Array.isArray(task.relevant_files)).toBe(true);
      expect(task.relevant_files.length).toBeGreaterThan(0);
      expect(Array.isArray(task.relevant_types)).toBe(true);
      expect(Array.isArray(task.relevant_keywords)).toBe(true);
      expect(Array.isArray(task.irrelevant_files)).toBe(true);
      expect(typeof task.task_symbol_removed).toBe('string');
      expect(Array.isArray(task.removed_symbols)).toBe(true);
      // dataset paths are repo-root-relative, forward-slashed, never absolute
      for (const p of task.relevant_files) {
        expect(isAbsolute(p)).toBe(false);
        expect(p.includes(sep === '/' ? '\\' : '/')).toBe(false);
      }
    }
  });

  it('samples irrelevant files from the relevant pool, never overlapping the task', () => {
    const multi: RawCommit[] = [
      { hash: 'h1', subject: 'tune scorer thresholds', body: '', files: ['src/core/scorer.ts'] },
      { hash: 'h2', subject: 'tune router promotion', body: '', files: ['src/core/router.ts'] },
      { hash: 'h3', subject: 'tune chunker overlap', body: '', files: ['src/core/chunker.ts'] },
    ];
    const { dataset } = buildCommitDataset(options(), multi);
    expect(dataset.tasks.length).toBe(3);
    for (const task of dataset.tasks) {
      const relevant = new Set(task.relevant_files);
      expect(task.irrelevant_files.some((p) => relevant.has(p))).toBe(false);
    }
  });

  it('respects the size filter (drops mega-commits)', () => {
    const mega: RawCommit = {
      hash: 'big',
      subject: 'sweeping rename across the core',
      body: '',
      files: ['src/core/scorer.ts', 'src/core/router.ts', 'src/core/chunker.ts', 'src/core/retriever.ts'],
    };
    const { summary } = buildCommitDataset(options({ maxFiles: 2 }), [mega]);
    expect(summary.tasks).toBe(0);
    expect(summary.excludedSize).toBe(1);
  });
});

describe('integration: mines the project\'s own git history', () => {
  it('produces schema-valid tasks whose relevant files exist and are code', () => {
    const gitDir = join(projectRoot, '.git');
    if (!existsSync(gitDir)) return; // skip outside a checkout
    const { dataset, summary } = buildCommitDataset(options({ maxCommits: 150, limit: 25 }));
    expect(summary.commitsScanned).toBeGreaterThan(0);
    expect(dataset.tasks.length).toBeGreaterThan(0);
    for (const task of dataset.tasks) {
      expect(task.relevant_files.length).toBeGreaterThan(0);
      for (const p of task.relevant_files) {
        expect(existsSync(join(projectRoot, p))).toBe(true);
        expect(p).toMatch(/\.(ts|tsx|js|jsx|py|rs|go|java)$/);
      }
      // anti-leakage held: no relevant file is literally named in the message
      expect(messageNamesAnyFile(`${task.commit.subject}`, task.relevant_files)).toBe(false);
    }
  });
});
