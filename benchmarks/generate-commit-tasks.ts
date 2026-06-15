/**
 * Generate commit-derived retrieval ground truth from a local git repository.
 *
 * SWE-bench-style ground truth: the query is the commit / PR message, and the
 * relevant set is the code files the patch touched. This replaces the circular
 * "where is {symbol} defined" templates in `generate-heldout.ts`, which let
 * structural retrieval win by construction (the query embeds the exact ground
 * truth symbol name).
 *
 * Credibility guards baked in (WS0.6):
 *   - Anti-leakage: a task is dropped if its message literally names any of the
 *     changed files (basename, basename+ext, or full path) — otherwise the task
 *     is partly a string-match gimme.
 *   - Symbol-removed ablation: each task also carries a `task_symbol_removed`
 *     variant where exact identifiers are neutralised, so the eval can quantify
 *     how much of structural's win is genuine retrieval vs identifier lookup.
 *   - Size filter: mega-commits (refactors touching many files) are dropped so
 *     the relevant set models a realistic "find the file for this change" task.
 *
 * The generator writes only task metadata (no external source contents) and
 * refuses to write anywhere but /tmp, mirroring `generate-heldout.ts`.
 *
 * Usage:
 *   npx tsx benchmarks/generate-commit-tasks.ts \
 *     --repo corpora/django \
 *     --output /tmp/spacefolding-commit-django.json \
 *     --max-commits 600 --limit 100
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inferLanguageFromPath } from '../src/core/ingester.js';
import { isSupportedCodeLanguage } from '../src/providers/structural-indexer.js';
import {
  DEFAULT_BENCHMARK_SOURCE_EXTENSIONS,
  isBenchmarkTestPath,
  projectRelativePath,
} from './source-files.js';

type Intent = 'code_search' | 'debug' | 'explain' | 'implement';

export interface CommitTask {
  id: string;
  task: string;
  /** Symbol-removed ablation: exact identifiers neutralised. Equals `task` when none found. */
  task_symbol_removed: string;
  removed_symbols: string[];
  intent: Intent;
  relevant_files: string[];
  relevant_types: string[];
  relevant_keywords: string[];
  irrelevant_files: string[];
  source: 'commit-derived';
  commit: {
    hash: string;
    subject: string;
    files_touched: number;
  };
}

export interface CommitDataset {
  codebase: string;
  description: string;
  generated_at: string;
  commits_scanned: number;
  task_count: number;
  tasks: CommitTask[];
}

export interface CommitSummary {
  output: string;
  repo: string;
  commitsScanned: number;
  tasks: number;
  ablatedTasks: number;
  excludedNamedFile: number;
  excludedSize: number;
  excludedNoCodeFiles: number;
  byIntent: Record<Intent, number>;
}

export interface CliOptions {
  repo: string;
  output: string;
  maxCommits: number;
  limit: number;
  minFiles: number;
  maxFiles: number;
  includeTests: boolean;
  includeMerges: boolean;
  seed: string;
}

/** One commit as mined from `git log`, before filtering/shaping into a task. */
export interface RawCommit {
  hash: string;
  subject: string;
  body: string;
  files: string[];
}

const benchDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(benchDir, '..');
const commitOutputRoot = '/tmp';

const SOURCE_EXTENSIONS = new Set(DEFAULT_BENCHMARK_SOURCE_EXTENSIONS.map((ext) => ext.toLowerCase()));

const RECORD_SEP = '\x1e';
const FIELD_SEP = '\x1f';

const STOP_WORDS = new Set([
  'a', 'add', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'fix',
  'fixes', 'for', 'from', 'has', 'have', 'in', 'into', 'is', 'it', 'its', 'not',
  'of', 'on', 'or', 'that', 'the', 'this', 'to', 'use', 'using', 'when', 'with',
  'we', 'you', 'should', 'would', 'could', 'make', 'now', 'also', 'via',
]);

// Conventional-commit prefix: `type` or `type(scope)` followed by `:`.
const CONVENTIONAL_PREFIX =
  /^(build|chore|ci|docs?|feat|feature|fix|perf|refactor|revert|style|test)(\([^)]*\))?!?:\s*/i;

const INTENT_PATTERNS: Array<[RegExp, Intent]> = [
  [/\b(fix|bug|regression|crash|leak|hang|deadlock|npe|panic|incorrect|wrong|broken|error|fault|fail)/i, 'debug'],
  [/\b(add|implement|introduce|support|new|feature|feat|enable|create)\b/i, 'implement'],
  [/\b(refactor|cleanup|clean up|rename|move|simplify|reorganis|reorganiz|extract|inline|docs?|document|comment)\b/i, 'explain'],
];

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    repo: projectRoot,
    output: join('/tmp', 'spacefolding-commit-dataset.json'),
    maxCommits: 400,
    limit: 100,
    minFiles: 1,
    maxFiles: 5,
    includeTests: false,
    includeMerges: false,
    seed: 'commit',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') options.repo = readOptionValue(argv, i++, arg);
    else if (arg === '--output') options.output = readOptionValue(argv, i++, arg);
    else if (arg === '--max-commits') options.maxCommits = parsePositiveInt(readOptionValue(argv, i++, arg), 'max-commits');
    else if (arg === '--limit') options.limit = parsePositiveInt(readOptionValue(argv, i++, arg), 'limit');
    else if (arg === '--min-files') options.minFiles = parsePositiveInt(readOptionValue(argv, i++, arg), 'min-files');
    else if (arg === '--max-files') options.maxFiles = parsePositiveInt(readOptionValue(argv, i++, arg), 'max-files');
    else if (arg === '--include-tests') options.includeTests = true;
    else if (arg === '--include-merges') options.includeMerges = true;
    else if (arg === '--seed') options.seed = readOptionValue(argv, i++, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.minFiles > options.maxFiles) {
    throw new Error('--min-files must not exceed --max-files');
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

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

export function validateCommitOutputPath(output: string, root: string = projectRoot): void {
  const resolvedOutput = resolve(output);
  const resolvedRoot = realpathSync(resolve(root));
  const resolvedOutputParent = resolve(dirname(resolvedOutput));
  const realOutputParent = realpathIfExists(resolvedOutputParent);
  const realOutput = join(realOutputParent, basename(resolvedOutput));

  try {
    if (lstatSync(resolvedOutput).isSymbolicLink()) {
      throw new Error(
        `Refusing to write commit-derived dataset through a symlink: ${output}. Use a regular output path under /tmp.`
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (isWithinDirectory(realOutput, resolvedRoot)) {
    throw new Error(
      `Refusing to write commit-derived dataset inside the repository: ${output}. Use an output path under /tmp.`
    );
  }

  if (!isWithinDirectory(realOutput, realpathSync(commitOutputRoot))) {
    throw new Error(
      `Refusing to write commit-derived dataset outside /tmp: ${output}. Use an output path under /tmp.`
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

/**
 * Mine commits from `git log`. Two passes keyed by hash over the same window:
 * metadata (hash/subject/body) and changed files. Returns commits newest-first.
 */
export function collectCommits(repoDir: string, options: CliOptions): RawCommit[] {
  const window = ['--max-count', String(options.maxCommits)];
  if (!options.includeMerges) window.push('--no-merges');

  const metaRaw = runGit(repoDir, [
    'log', ...window,
    `--pretty=format:${RECORD_SEP}%H${FIELD_SEP}%s${FIELD_SEP}%b`,
  ]);
  const filesRaw = runGit(repoDir, [
    'log', ...window, '--name-only',
    `--pretty=format:${RECORD_SEP}%H`,
  ]);

  const filesByHash = new Map<string, string[]>();
  for (const chunk of filesRaw.split(RECORD_SEP)) {
    const lines = chunk.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const [hash, ...files] = lines;
    filesByHash.set(hash, files);
  }

  const commits: RawCommit[] = [];
  for (const record of metaRaw.split(RECORD_SEP)) {
    if (record.trim().length === 0) continue;
    const firstSep = record.indexOf(FIELD_SEP);
    const secondSep = record.indexOf(FIELD_SEP, firstSep + 1);
    if (firstSep === -1 || secondSep === -1) continue;
    const hash = record.slice(0, firstSep).trim();
    const subject = record.slice(firstSep + 1, secondSep).trim();
    const body = record.slice(secondSep + 1).replace(/\s+$/, '');
    if (!hash) continue;
    commits.push({ hash, subject, body, files: filesByHash.get(hash) ?? [] });
  }

  return commits;
}

function runGit(repoDir: string, args: string[]): string {
  return execFileSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

function isCodeFile(repoRelativePath: string, includeTests: boolean): boolean {
  if (!SOURCE_EXTENSIONS.has(extname(repoRelativePath).toLowerCase())) return false;
  if (!isSupportedCodeLanguage(inferLanguageFromPath(repoRelativePath))) return false;
  if (!includeTests && isBenchmarkTestPath(repoRelativePath)) return false;
  return true;
}

/**
 * Strip a conventional-commit prefix and common trailers, keep the subject plus
 * the first paragraph of the body, and cap the length. Models the issue/PR text
 * a user would actually type.
 */
export function buildQuery(subject: string, body: string, maxLength = 320): string {
  const cleanSubject = subject.replace(CONVENTIONAL_PREFIX, '').trim();
  const firstParagraph = body
    .split(/\n\s*\n/)[0]
    ?.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isTrailerLine(line))
    .join(' ')
    .trim() ?? '';

  const joiner = /[.!?]$/.test(cleanSubject) ? ' ' : '. ';
  const combined = firstParagraph ? `${cleanSubject}${joiner}${firstParagraph}` : cleanSubject;
  const normalised = combined.replace(/\s+/g, ' ').trim();
  if (normalised.length <= maxLength) return normalised;
  return `${normalised.slice(0, maxLength).replace(/\s+\S*$/, '')}…`;
}

function isTrailerLine(line: string): boolean {
  // Colon-style metadata trailers (Signed-off-by:, Co-authored-by:, ...).
  if (/^(signed-off-by|co-authored-by|reviewed-by|acked-by|tested-by|cc|change-id|git-svn-id|bug|pr-url|reviewed|message-id):/i.test(line)) {
    return true;
  }
  // GitHub-style issue closers — require a `#<number>` so description lines that
  // merely start with "Fix the race condition" are not mistaken for trailers.
  if (/^(closes?|fixe?s?|fixed|resolves?|refs?|references?|see|related(\s+to)?)\b\s*:?\s*#\d+/i.test(line)) {
    return true;
  }
  return /^cherry[- ]picked/i.test(line);
}

export function classifyIntent(subject: string): Intent {
  const text = subject.toLowerCase();
  for (const [pattern, intent] of INTENT_PATTERNS) {
    if (pattern.test(text)) return intent;
  }
  return 'code_search';
}

/**
 * Anti-leakage: does the message literally name this file? Flags the full path,
 * the basename+extension, or a distinctive (code-shaped) basename. A plain-word
 * basename like `models.py` only counts if the extension is present, so common
 * words don't drop otherwise-valid tasks.
 */
export function messageNamesFile(message: string, repoRelativePath: string): boolean {
  const lower = message.toLowerCase();
  const pathLower = repoRelativePath.toLowerCase();
  const base = basename(repoRelativePath);
  const baseLower = base.toLowerCase();
  const baseNoExt = base.slice(0, base.length - extname(base).length);
  const baseNoExtLower = baseNoExt.toLowerCase();

  if (lower.includes(pathLower)) return true;
  if (lower.includes(baseLower)) return true; // basename WITH extension
  if (baseNoExt.length >= 3 && isCodeShaped(baseNoExt)) {
    if (new RegExp(`\\b${escapeRegExp(baseNoExtLower)}\\b`).test(lower)) return true;
  }
  return false;
}

export function messageNamesAnyFile(message: string, repoRelativePaths: string[]): boolean {
  return repoRelativePaths.some((path) => messageNamesFile(message, path));
}

/** A token that reads like a code identifier rather than an English word. */
export function isCodeShaped(token: string): boolean {
  if (token.length < 3) return false;
  if (token.includes('_')) return true;                  // snake_case
  if (/[a-z][A-Z]/.test(token)) return true;             // camelCase
  if (/^[A-Z][a-z]+[A-Z][a-z]/.test(token)) return true; // PascalCase, 2+ humps
  if (/[A-Za-z][0-9]|[0-9][A-Za-z]/.test(token)) return true; // alnum mix
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Symbol-removed ablation. Neutralises exact identifiers in the query: anything
 * inside backticks, names defined in the touched files, and clearly code-shaped
 * tokens. Returns the rewritten query and the list of removed identifiers.
 */
export function ablateSymbols(
  query: string,
  definedSymbols: Map<string, string>
): { text: string; removed: string[] } {
  const removed = new Set<string>();
  let text = query;

  // 1. Backticked code spans: `foo.bar()` -> placeholder, backticks dropped.
  text = text.replace(/`([^`]+)`/g, (_match, inner: string) => {
    const token = String(inner).trim();
    const head = token.split(/[^A-Za-z0-9_$.]/)[0] ?? token;
    if (head && (definedSymbols.has(head) || isCodeShaped(head))) {
      removed.add(head);
      return placeholderFor(definedSymbols.get(head));
    }
    return token; // keep prose that merely happened to be in backticks
  });

  // 2. Bare identifier tokens (incl. dotted member access).
  text = text.replace(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\b/g, (match) => {
    const head = match.split('.')[0];
    const isDefined = definedSymbols.has(match) || definedSymbols.has(head);
    if (isDefined) {
      removed.add(definedSymbols.has(match) ? match : head);
      return placeholderFor(definedSymbols.get(match) ?? definedSymbols.get(head));
    }
    if (isCodeShaped(match) && match.length >= 4) {
      removed.add(match);
      return placeholderFor(undefined);
    }
    return match;
  });

  const cleaned = text.replace(/\s+/g, ' ').trim();
  return { text: cleaned, removed: [...removed] };
}

function placeholderFor(kind: string | undefined): string {
  switch (kind) {
    case 'function':
    case 'method':
      return 'the relevant function';
    case 'class':
    case 'interface':
    case 'type':
    case 'struct':
    case 'enum':
    case 'trait':
      return 'the relevant component';
    case 'constant':
      return 'the relevant value';
    default:
      return 'the relevant code';
  }
}

/** Lightweight defined-symbol scan (name -> kind) across the touched files' current contents. */
export function extractDefinedSymbols(absoluteFilePaths: string[]): Map<string, string> {
  const symbols = new Map<string, string>();
  for (const filePath of absoluteFilePaths) {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const language = inferLanguageFromPath(filePath);
    for (const [name, kind] of scanSymbols(content, language)) {
      if (!symbols.has(name)) symbols.set(name, kind);
    }
  }
  return symbols;
}

function scanSymbols(content: string, language: string | undefined): Array<[string, string]> {
  const patterns = symbolPatternsFor(language);
  const found: Array<[string, string]> = [];
  for (const [pattern, kind] of patterns) {
    for (const match of content.matchAll(pattern)) {
      const name = match[1];
      if (name && name.length >= 3) found.push([name, kind]);
    }
  }
  return found;
}

function symbolPatternsFor(language: string | undefined): Array<[RegExp, string]> {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return [
        [/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, 'function'],
        [/\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g, 'class'],
        [/\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g, 'interface'],
        [/\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/g, 'type'],
        [/\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g, 'function'],
      ];
    case 'python':
      return [
        [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm, 'function'],
        [/^\s*class\s+([A-Za-z_]\w*)\s*[:(]/gm, 'class'],
      ];
    case 'rust':
      return [
        [/\b(?:pub\s+)?fn\s+([A-Za-z_]\w*)/g, 'function'],
        [/\b(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/g, 'type'],
      ];
    case 'go':
      return [
        [/\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/g, 'function'],
        [/\btype\s+([A-Za-z_]\w*)\s+(?:struct|interface)/g, 'type'],
      ];
    case 'java':
      return [
        [/\b(?:class|interface|enum)\s+([A-Za-z_]\w*)/g, 'class'],
      ];
    default:
      return [];
  }
}

function messageKeywords(query: string, removed: Set<string>): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const raw of query.split(/[^A-Za-z0-9_$]+/)) {
    const token = raw.trim();
    if (token.length < 3) continue;
    const lower = token.toLowerCase();
    if (STOP_WORDS.has(lower) || removed.has(token)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    keywords.push(token);
    if (keywords.length >= 8) break;
  }
  return keywords;
}

export function buildCommitDataset(
  options: CliOptions,
  injectedCommits?: RawCommit[]
): { dataset: CommitDataset; summary: CommitSummary } {
  const repoDir = resolve(options.repo);
  const commits = injectedCommits ?? collectCommits(repoDir, options);

  const byIntent: Record<Intent, number> = { code_search: 0, debug: 0, explain: 0, implement: 0 };
  let excludedNamedFile = 0;
  let excludedSize = 0;
  let excludedNoCodeFiles = 0;
  let ablatedTasks = 0;

  const tasks: CommitTask[] = [];
  for (const commit of commits) {
    const codeFiles = dedupe(commit.files)
      .filter((file) => isCodeFile(file, options.includeTests))
      .filter((file) => existsSync(resolve(repoDir, file)));

    if (codeFiles.length === 0) { excludedNoCodeFiles++; continue; }
    if (codeFiles.length < options.minFiles || codeFiles.length > options.maxFiles) {
      excludedSize++;
      continue;
    }

    const message = `${commit.subject}\n${commit.body}`;
    if (messageNamesAnyFile(message, codeFiles)) { excludedNamedFile++; continue; }

    const query = buildQuery(commit.subject, commit.body);
    if (query.length < 12) continue; // too thin to be a meaningful query

    const absolutePaths = codeFiles.map((file) => resolve(repoDir, file));
    const definedSymbols = extractDefinedSymbols(absolutePaths);
    const ablation = ablateSymbols(query, definedSymbols);
    if (ablation.removed.length > 0) ablatedTasks++;

    const intent = classifyIntent(commit.subject);
    byIntent[intent]++;

    tasks.push({
      id: `C${String(tasks.length + 1).padStart(3, '0')}`,
      task: query,
      task_symbol_removed: ablation.text,
      removed_symbols: ablation.removed,
      intent,
      relevant_files: codeFiles.map((file) => toDatasetPath(repoDir, file)).sort(),
      relevant_types: ['code'],
      relevant_keywords: messageKeywords(query, new Set(ablation.removed)),
      irrelevant_files: [],
      source: 'commit-derived',
      commit: {
        hash: commit.hash,
        subject: commit.subject,
        files_touched: codeFiles.length,
      },
    });

    if (tasks.length >= options.limit) break;
  }

  assignIrrelevantFiles(tasks, options.seed);

  const dataset: CommitDataset = {
    codebase: repoDir,
    description:
      'Commit-derived benchmark dataset. Queries are commit/PR messages; relevant files are the code files each patch touched (paths relative to the Spacefolding project root). Each task carries a symbol-removed ablation variant.',
    generated_at: new Date(0).toISOString(),
    commits_scanned: commits.length,
    task_count: tasks.length,
    tasks,
  };

  return {
    dataset,
    summary: {
      output: options.output,
      repo: repoDir,
      commitsScanned: commits.length,
      tasks: tasks.length,
      ablatedTasks,
      excludedNamedFile,
      excludedSize,
      excludedNoCodeFiles,
      byIntent,
    },
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function toDatasetPath(repoDir: string, repoRelativePath: string): string {
  return projectRelativePath(projectRoot, resolve(repoDir, repoRelativePath));
}

/** Sample irrelevant files for each task from the pool of all relevant files (deterministic). */
function assignIrrelevantFiles(tasks: CommitTask[], seed: string): void {
  const pool = [...new Set(tasks.flatMap((task) => task.relevant_files))].sort();
  for (const task of tasks) {
    const relevant = new Set(task.relevant_files);
    const candidates = pool.filter((path) => !relevant.has(path));
    task.irrelevant_files = deterministicShuffle(candidates, `${seed}:${task.id}`).slice(0, 3);
  }
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

export function writeCommitDataset(options: CliOptions): CommitSummary {
  validateCommitOutputPath(options.output);
  const { dataset, summary } = buildCommitDataset(options);
  writeFileSync(options.output, JSON.stringify(dataset, null, 2));
  return summary;
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  try {
    const summary = writeCommitDataset(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error('Commit-derived generation failed:', error);
    process.exit(1);
  }
}
