/**
 * Generate held-out retrieval datasets from an arbitrary local corpus.
 *
 * The generated tasks use source symbols as ground truth and write only task
 * metadata, not external source contents. Use an output path under /tmp when
 * benchmarking private repos.
 *
 * Usage:
 *   npx tsx benchmarks/generate-heldout.ts --corpus /path/to/repo --output /tmp/repo-dataset.json --limit 60
 */

import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inferLanguageFromPath } from '../src/core/ingester.js';
import { isSupportedCodeLanguage } from '../src/providers/structural-indexer.js';

type Intent = 'code_search' | 'debug' | 'explain' | 'implement';

export interface HeldoutTask {
  id: string;
  task: string;
  intent: Intent;
  relevant_files: string[];
  relevant_types: string[];
  relevant_keywords: string[];
  irrelevant_files: string[];
  source: 'heldout-generated';
  symbol: {
    name: string;
    kind: string;
    language: string;
  };
}

interface SymbolCandidate {
  name: string;
  kind: string;
  language: string;
  filePath: string;
}

export interface HeldoutDataset {
  codebase: string;
  description: string;
  generated_at: string;
  source_file_count: number;
  symbol_count: number;
  tasks: HeldoutTask[];
}

export interface HeldoutSummary {
  output: string;
  corpus: string;
  sourceFiles: number;
  symbols: number;
  tasks: number;
  byLanguage: Record<string, number>;
}

export interface CliOptions {
  corpus: string;
  output: string;
  limit: number;
  maxPerFile: number;
  seed: string;
  includeTests: boolean;
}

const benchDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(benchDir, '..');
const heldoutOutputRoot = '/tmp';

const SKIP_DIRS = new Set([
  '.cache',
  '.claude',
  '.codex',
  '.cursor',
  '.git',
  '.hg',
  '.mypy_cache',
  '.svn',
  '.next',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  '.turbo',
  '.venv',
  '__pycache__',
  'benchmarks',
  'build',
  'coverage',
  'data',
  'dist',
  'deps',
  'node_modules',
  'out',
  'target',
  'vendor',
  'venv',
]);

const TEST_DIRS = new Set([
  '__tests__',
  'fixtures',
  'mock',
  'mocks',
  'spec',
  'test',
  'tests',
]);

const QUERY_TEMPLATES: Record<Intent, string[]> = {
  code_search: [
    'where is {symbol} defined',
    'find the {symbol} {kind}',
    'which file contains {symbol}',
  ],
  debug: [
    'debug the {symbol} {kind}',
    'fix an issue in {symbol}',
    '{symbol} is returning wrong values',
  ],
  explain: [
    'explain the {symbol} implementation',
    'how does {symbol} work',
    'what does {symbol} do',
  ],
  implement: [
    'add error handling around {symbol}',
    'extend {symbol} to support a new case',
    'add tests for {symbol}',
  ],
};

const GENERIC_SYMBOLS = new Set([
  '__init__',
  'app',
  'config',
  'data',
  'get',
  'handler',
  'index',
  'init',
  'label',
  'main',
  'put',
  'query',
  'request',
  'response',
  'result',
  'run',
  'set',
  'setup',
  'statistics',
  'status',
  'test',
  'update',
  'value',
]);

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    corpus: join(projectRoot, 'src'),
    output: join('/tmp', 'spacefolding-heldout-dataset.json'),
    limit: 80,
    maxPerFile: 3,
    seed: 'heldout',
    includeTests: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--corpus') options.corpus = readOptionValue(argv, i++, arg);
    else if (arg === '--output') options.output = readOptionValue(argv, i++, arg);
    else if (arg === '--limit') options.limit = parsePositiveInt(readOptionValue(argv, i++, arg), 'limit');
    else if (arg === '--max-per-file') options.maxPerFile = parsePositiveInt(readOptionValue(argv, i++, arg), 'max-per-file');
    else if (arg === '--seed') options.seed = readOptionValue(argv, i++, arg);
    else if (arg === '--include-tests') options.includeTests = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function readOptionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function validateHeldoutOutputPath(output: string, root: string = projectRoot): void {
  const resolvedOutput = resolve(output);
  const resolvedRoot = realpathSync(resolve(root));
  const resolvedOutputParent = resolve(dirname(resolvedOutput));
  const realOutputParent = realpathIfExists(resolvedOutputParent);
  const realOutput = join(realOutputParent, basename(resolvedOutput));

  try {
    if (lstatSync(resolvedOutput).isSymbolicLink()) {
      throw new Error(
        `Refusing to write generated held-out dataset through a symlink: ${output}. Use a regular output path under /tmp.`
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (isWithinDirectory(realOutput, resolvedRoot)) {
    throw new Error(
      `Refusing to write generated held-out dataset inside the repository: ${output}. Use an output path under /tmp.`
    );
  }

  if (!isWithinDirectory(realOutput, realpathSync(heldoutOutputRoot))) {
    throw new Error(
      `Refusing to write generated held-out dataset outside /tmp: ${output}. Use an output path under /tmp.`
    );
  }
}

function realpathIfExists(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(path);
    throw error;
  }
}

function isWithinDirectory(path: string, directory: string): boolean {
  const relativePath = relative(resolve(directory), resolve(path));
  return relativePath === ''
    || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function walkDir(dir: string, includeTests: boolean): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (shouldSkipDirectory(entry, includeTests)) continue;
      files.push(...walkDir(fullPath, includeTests));
      continue;
    }

    if (!codeLanguageForPath(entry)) continue;
    if (!includeTests && isTestPath(fullPath)) continue;
    files.push(fullPath);
  }
  return files.sort();
}

function codeLanguageForPath(filePath: string): string | undefined {
  const language = inferLanguageFromPath(filePath);
  return isSupportedCodeLanguage(language) ? language : undefined;
}

function shouldSkipDirectory(entry: string, includeTests: boolean): boolean {
  const normalized = entry.toLowerCase();
  return SKIP_DIRS.has(normalized) || (!includeTests && TEST_DIRS.has(normalized));
}

function isTestPath(filePath: string): boolean {
  const normalized = filePath.split(sep).join('/');
  return /(^|\/)(__tests__|tests?|spec|fixtures|mocks?)(\/|$)/i.test(normalized)
    || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(normalized)
    || /test_.*\.py$/i.test(normalized)
    || /_test\.go$/i.test(normalized);
}

function extractSymbols(content: string, filePath: string): SymbolCandidate[] {
  const language = codeLanguageForPath(filePath);
  if (!language) return [];

  switch (language) {
    case 'typescript':
    case 'javascript':
      return extractTsJsSymbols(content, filePath, language);
    case 'python':
      return extractPythonSymbols(content, filePath, language);
    case 'rust':
      return extractRustSymbols(content, filePath, language);
    case 'go':
      return extractGoSymbols(content, filePath, language);
    case 'java':
      return extractJavaSymbols(content, filePath, language);
    default:
      return [];
  }
}

function extractTsJsSymbols(content: string, filePath: string, language: string): SymbolCandidate[] {
  return collectMatches(content, filePath, language, [
    [/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, 'function'],
    [/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, 'function'],
    [/\bexport\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g, 'class'],
    [/\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g, 'class'],
    [/\bexport\s+interface\s+([A-Za-z_$][\w$]*)/g, 'interface'],
    [/\binterface\s+([A-Za-z_$][\w$]*)/g, 'interface'],
    [/\bexport\s+type\s+([A-Za-z_$][\w$]*)/g, 'type'],
    [/\btype\s+([A-Za-z_$][\w$]*)\s*=/g, 'type'],
    [/\bexport\s+const\s+([A-Za-z_$][\w$]*)/g, 'constant'],
    [/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g, 'function'],
  ]);
}

function extractPythonSymbols(content: string, filePath: string, language: string): SymbolCandidate[] {
  return collectMatches(content, filePath, language, [
    [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm, 'function'],
    [/^\s*class\s+([A-Za-z_]\w*)\s*[:(]/gm, 'class'],
  ]);
}

function extractRustSymbols(content: string, filePath: string, language: string): SymbolCandidate[] {
  return collectMatches(content, filePath, language, [
    [/\b(?:pub\s+)?fn\s+([A-Za-z_]\w*)\s*</g, 'function'],
    [/\b(?:pub\s+)?fn\s+([A-Za-z_]\w*)\s*\(/g, 'function'],
    [/\b(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/g, 'type'],
  ]);
}

function extractGoSymbols(content: string, filePath: string, language: string): SymbolCandidate[] {
  return collectMatches(content, filePath, language, [
    [/\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/g, 'function'],
    [/\btype\s+([A-Za-z_]\w*)\s+(?:struct|interface)/g, 'type'],
  ]);
}

function extractJavaSymbols(content: string, filePath: string, language: string): SymbolCandidate[] {
  return collectMatches(content, filePath, language, [
    [/\b(?:public|protected|private)?\s*(?:abstract\s+|final\s+)?(?:class|interface|enum)\s+([A-Za-z_]\w*)/g, 'class'],
    [/\b(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?[A-Za-z_<>, ?[\]]+\s+([A-Za-z_]\w*)\s*\(/g, 'method'],
  ]);
}

function collectMatches(
  content: string,
  filePath: string,
  language: string,
  patterns: Array<[RegExp, string]>
): SymbolCandidate[] {
  const seen = new Set<string>();
  const symbols: SymbolCandidate[] = [];
  for (const [pattern, kind] of patterns) {
    for (const match of content.matchAll(pattern)) {
      const name = match[1];
      if (!isUsefulSymbol(name)) continue;
      const key = `${kind}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({ name, kind, language, filePath });
    }
  }
  return symbols;
}

function isUsefulSymbol(name: string): boolean {
  const normalized = name.toLowerCase();
  if (name.length < 3) return false;
  if (/^test[_A-Z]/i.test(name)) return false;
  if (/^__.*__$/.test(name)) return false;
  return !GENERIC_SYMBOLS.has(normalized);
}

function generateTasks(symbols: SymbolCandidate[], options: CliOptions): HeldoutTask[] {
  const shuffled = deterministicShuffle(symbols, options.seed);
  const perFileCounts = new Map<string, number>();
  const allPaths = [...new Set(symbols.map((symbol) => toDatasetPath(symbol.filePath)))].sort();
  const tasks: HeldoutTask[] = [];

  for (const symbol of shuffled) {
    const currentCount = perFileCounts.get(symbol.filePath) ?? 0;
    if (currentCount >= options.maxPerFile) continue;

    const intent = pickIntent(symbol, options.seed);
    const templates = QUERY_TEMPLATES[intent];
    const template = templates[hashString(`${options.seed}:${symbol.filePath}:${symbol.name}:template`) % templates.length];
    const taskText = template
      .replace('{symbol}', symbol.name)
      .replace('{kind}', symbol.kind);
    const relevantPath = toDatasetPath(symbol.filePath);

    tasks.push({
      id: `H${String(tasks.length + 1).padStart(3, '0')}`,
      task: taskText,
      intent,
      relevant_files: [relevantPath],
      relevant_types: ['code'],
      relevant_keywords: keywordParts(symbol.name, symbol.kind),
      irrelevant_files: deterministicShuffle(
        allPaths.filter((path) => path !== relevantPath),
        `${options.seed}:${symbol.filePath}:${symbol.name}:irrelevant`
      ).slice(0, 3),
      source: 'heldout-generated',
      symbol: {
        name: symbol.name,
        kind: symbol.kind,
        language: symbol.language,
      },
    });

    perFileCounts.set(symbol.filePath, currentCount + 1);
    if (tasks.length >= options.limit) break;
  }

  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

function pickIntent(symbol: SymbolCandidate, seed: string): Intent {
  const intents: Intent[] = ['code_search', 'debug', 'explain', 'implement'];
  return intents[hashString(`${seed}:${symbol.filePath}:${symbol.name}:intent`) % intents.length];
}

function keywordParts(symbol: string, kind: string): string[] {
  return [
    symbol,
    kind,
    ...symbol
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_$.-]+/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter((part) => part.length > 2),
  ].filter((value, index, all) => all.indexOf(value) === index);
}

function toDatasetPath(filePath: string): string {
  return relative(projectRoot, filePath).split(sep).join('/');
}

function deterministicShuffle<T>(items: T[], seed: string): T[] {
  return [...items].sort((a, b) =>
    hashString(`${seed}:${JSON.stringify(a)}`) - hashString(`${seed}:${JSON.stringify(b)}`)
  );
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function buildHeldoutDataset(options: CliOptions): { dataset: HeldoutDataset; summary: HeldoutSummary } {
  const corpus = options.corpus;
  const files = walkDir(corpus, options.includeTests);
  const symbols = files.flatMap((filePath) => {
    const content = readFileSync(filePath, 'utf-8');
    return extractSymbols(content, filePath);
  });
  const tasks = generateTasks(symbols, options);
  const byLanguage = tasks.reduce<Record<string, number>>((acc, task) => {
    acc[task.symbol.language] = (acc[task.symbol.language] ?? 0) + 1;
    return acc;
  }, {});

  const dataset: HeldoutDataset = {
    codebase: corpus,
    description: 'Held-out generated benchmark dataset. Relevant paths are relative to the Spacefolding project root.',
    generated_at: new Date(0).toISOString(),
    source_file_count: files.length,
    symbol_count: symbols.length,
    tasks,
  };

  return {
    dataset,
    summary: {
      output: options.output,
      corpus,
      sourceFiles: files.length,
      symbols: symbols.length,
      tasks: tasks.length,
      byLanguage,
    },
  };
}

export function writeHeldoutDataset(options: CliOptions): HeldoutSummary {
  validateHeldoutOutputPath(options.output);
  const { dataset, summary } = buildHeldoutDataset(options);
  writeFileSync(options.output, JSON.stringify(dataset, null, 2));
  return summary;
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  try {
    const summary = writeHeldoutDataset(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error('Held-out generation failed:', error);
    process.exit(1);
  }
}
