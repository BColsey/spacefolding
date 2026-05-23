/**
 * Benchmark Task Generator
 *
 * Auto-generates benchmark tasks from source files by extracting
 * symbols (functions, classes, interfaces, exports) and creating
 * realistic queries with those symbols as ground truth.
 *
 * Supports TypeScript, JavaScript, Python, Java, Rust, and Go files.
 *
 * Usage:
 *   npx tsx benchmarks/generate-tasks.ts [--sources src,benchmarks/fixtures] [--count 250] [--output /tmp/spacefolding-generated-tasks.json]
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const benchDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(benchDir, '..');

// ── Types ────────────────────────────────────────────────────────

interface Task {
  id: string;
  task: string;
  intent: string;
  relevant_files: string[];
  relevant_types: string[];
  relevant_keywords: string[];
  difficulty: 'easy' | 'medium' | 'hard';
  source: 'expert' | 'generated';
}

interface ExpertTask {
  id: string;
  task: string;
  intent: string;
  relevant_files: string[];
  relevant_types: string[];
  relevant_keywords: string[];
  irrelevant_files?: string[];
}

export interface GenOptions {
  sources: string[];
  count: number;
  output: string;
}

// ── Deterministic RNG ────────────────────────────────────────────

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRng(seedText: string): () => number {
  let state = hashString(seedText) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

function deterministicShuffle<T>(items: T[], seed: string): T[] {
  return [...items].sort((a, b) =>
    hashString(`${seed}:${String(a)}`) - hashString(`${seed}:${String(b)}`)
  );
}

// ── Intent templates ─────────────────────────────────────────────

const TEMPLATES: Record<string, string[]> = {
  code_search: [
    'find the {symbol} {kind}',
    'where is {symbol} defined',
    'locate the {kind} that handles {symbol}',
    'show me the {symbol} {kind}',
    'grep for {symbol}',
    'find where {symbol} is used',
    'which file contains the {symbol} {kind}',
  ],
  debug: [
    'fix the bug in {symbol}',
    'there is an error in the {symbol} {kind}',
    'debug the {symbol} function',
    '{symbol} is returning wrong values',
    'the {symbol} {kind} throws an exception',
    'fix the issue with {symbol}',
  ],
  explain: [
    'how does {symbol} work',
    'explain the {symbol} {kind}',
    'what does {symbol} do',
    'describe the {symbol} implementation',
    'understand how {symbol} interacts with the system',
  ],
  implement: [
    'add caching to {symbol}',
    'refactor the {symbol} {kind}',
    'improve error handling in {symbol}',
    'add tests for {symbol}',
    'optimize the {symbol} function',
    'extend {symbol} to support new features',
  ],
};

const INTENTS = Object.keys(TEMPLATES);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.rs', '.go']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '__pycache__', 'target', 'build']);

// ── Symbol extraction (multi-language) ───────────────────────────

function extractSymbols(content: string, filePath: string): { name: string; kind: string }[] {
  const symbols: { name: string; kind: string }[] = [];
  const ext = extname(filePath);

  if (ext === '.ts' || ext === '.tsx') {
    extractTypeScriptSymbols(content, symbols);
  } else if (ext === '.js' || ext === '.jsx') {
    extractJavaScriptSymbols(content, symbols);
  } else if (ext === '.py') {
    extractPythonSymbols(content, symbols);
  } else if (ext === '.java') {
    extractJavaSymbols(content, symbols);
  } else if (ext === '.rs') {
    extractRustSymbols(content, symbols);
  } else if (ext === '.go') {
    extractGoSymbols(content, symbols);
  }

  return symbols;
}

function extractTypeScriptSymbols(content: string, symbols: { name: string; kind: string }[]): void {
  for (const m of content.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g))
    symbols.push({ name: m[1], kind: 'function' });
  for (const m of content.matchAll(/export\s+(?:abstract\s+)?class\s+(\w+)/g))
    symbols.push({ name: m[1], kind: 'class' });
  for (const m of content.matchAll(/export\s+interface\s+(\w+)/g))
    symbols.push({ name: m[1], kind: 'interface' });
  for (const m of content.matchAll(/export\s+type\s+(\w+)/g))
    symbols.push({ name: m[1], kind: 'type' });
  for (const m of content.matchAll(/export\s+const\s+(\w+)/g))
    symbols.push({ name: m[1], kind: 'constant' });
}

function extractJavaScriptSymbols(content: string, symbols: { name: string; kind: string }[]): void {
  for (const m of content.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g))
    symbols.push({ name: m[1], kind: 'function' });
  for (const m of content.matchAll(/(?:export\s+)?class\s+(\w+)/g))
    symbols.push({ name: m[1], kind: 'class' });
  for (const m of content.matchAll(/(?:export\s+)?const\s+(\w+)\s*=/g))
    symbols.push({ name: m[1], kind: 'constant' });
  // CommonJS exports
  for (const m of content.matchAll(/exports\.(\w+)\s*=/g))
    symbols.push({ name: m[1], kind: 'function' });
  for (const m of content.matchAll(/module\.exports\.(\w+)\s*=/g))
    symbols.push({ name: m[1], kind: 'function' });
}

function extractPythonSymbols(content: string, symbols: { name: string; kind: string }[]): void {
  for (const m of content.matchAll(/^class\s+(\w+)/gm))
    symbols.push({ name: m[1], kind: 'class' });
  for (const m of content.matchAll(/^\s+def\s+(\w+)/gm))
    symbols.push({ name: m[1], kind: 'method' });
  for (const m of content.matchAll(/^def\s+(\w+)/gm))
    symbols.push({ name: m[1], kind: 'function' });
}

function extractJavaSymbols(content: string, symbols: { name: string; kind: string }[]): void {
  for (const m of content.matchAll(/(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface|enum)\s+(\w+)/g))
    symbols.push({ name: m[1], kind: 'class' });
  for (const m of content.matchAll(/(?:public|private|protected)\s+(?:static\s+)?(?:\w+(?:<[^>]+>)?\s+)+(\w+)\s*\(/g))
    symbols.push({ name: m[1], kind: 'method' });
}

function extractRustSymbols(content: string, symbols: { name: string; kind: string }[]): void {
  for (const m of content.matchAll(/pub\s+(?:async\s+)?fn\s+(\w+)/g))
    symbols.push({ name: m[1], kind: 'function' });
  for (const m of content.matchAll(/fn\s+(\w+)/g))
    symbols.push({ name: m[1], kind: 'function' });
  for (const m of content.matchAll(/pub\s+struct\s+(\w+)/g))
    symbols.push({ name: m[1], kind: 'struct' });
  for (const m of content.matchAll(/struct\s+(\w+)/g))
    symbols.push({ name: m[1], kind: 'struct' });
  for (const m of content.matchAll(/pub\s+enum\s+(\w+)/g))
    symbols.push({ name: m[1], kind: 'enum' });
  for (const m of content.matchAll(/pub\s+trait\s+(\w+)/g))
    symbols.push({ name: m[1], kind: 'trait' });
}

function extractGoSymbols(content: string, symbols: { name: string; kind: string }[]): void {
  for (const m of content.matchAll(/func\s+(?:\([^)]+\)\s+)?(\w+)/g))
    symbols.push({ name: m[1], kind: 'function' });
  for (const m of content.matchAll(/type\s+(\w+)\s+struct/g))
    symbols.push({ name: m[1], kind: 'struct' });
  for (const m of content.matchAll(/type\s+(\w+)\s+interface/g))
    symbols.push({ name: m[1], kind: 'interface' });
}

// ── File walking ─────────────────────────────────────────────────

function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) results.push(...walkDir(fullPath));
    } else if (SOURCE_EXTENSIONS.has(extname(entry))) {
      results.push(fullPath);
    }
  }
  return results;
}

// ── Task generation ──────────────────────────────────────────────

function generateTasks(sourceDirs: string[], projectRoot: string): Task[] {
  // Collect files from all source directories
  const files: string[] = [];
  for (const dir of sourceDirs) {
    files.push(...walkDir(dir));
  }

  // Map file paths to relative paths from project root
  const fileMap = new Map<string, string>();
  for (const filePath of files) {
    const relativePath = relative(projectRoot, filePath);
    fileMap.set(filePath, relativePath);
  }

  const allRelativePaths = [...fileMap.values()];
  const tasks: Task[] = [];
  let taskId = 0;

  for (const filePath of files) {
    const relativePath = fileMap.get(filePath)!;
    const content = readFileSync(filePath, 'utf-8');
    const symbols = extractSymbols(content, relativePath);

    for (const symbol of symbols) {
      // Generate one task per intent for each symbol to ensure balanced distribution
      for (const intent of INTENTS) {
        const rng = createRng(`${relativePath}:${symbol.name}:${intent}`);
        const templates = TEMPLATES[intent];
        const template = templates[Math.floor(rng() * templates.length)];

        const query = template
          .replace('{symbol}', symbol.name)
          .replace('{kind}', symbol.kind);

        // Determine difficulty
        const relevantFiles = [relativePath];
        const difficulty: Task['difficulty'] =
          ['easy', 'medium', 'hard'][Math.floor(rng() * 3)] as Task['difficulty'];

        if (difficulty === 'medium') {
          const sameDir = allRelativePaths.filter(p =>
            p !== relativePath && dirname(p) === dirname(relativePath)
          );
          const extra = deterministicShuffle(sameDir, `${relativePath}:${symbol.name}:${intent}:medium`)
            .slice(0, Math.min(2, sameDir.length));
          relevantFiles.push(...extra);
        } else if (difficulty === 'hard') {
          const others = allRelativePaths.filter(p => p !== relativePath);
          const extra = deterministicShuffle(others, `${relativePath}:${symbol.name}:${intent}:hard`)
            .slice(0, Math.min(4, others.length));
          relevantFiles.push(...extra);
        }

        const keywords = [symbol.name, symbol.kind]
          .concat(query.toLowerCase().split(/\s+/).filter(w => w.length > 3))
          .filter((v, i, a) => a.indexOf(v) === i);

        taskId++;
        tasks.push({
          id: `G${String(taskId).padStart(3, '0')}`,
          task: query,
          intent,
          relevant_files: [...new Set(relevantFiles)],
          relevant_types: ['code'],
          relevant_keywords: keywords.slice(0, 8),
          difficulty,
          source: 'generated',
        });
      }
    }
  }

  return tasks;
}

// ── CLI arg parsing ──────────────────────────────────────────────

export function parseArgs(argv: string[]): GenOptions {
  const options: GenOptions = {
    sources: [
      join(projectRoot, 'src'),
      join(projectRoot, 'benchmarks', 'fixtures'),
    ],
    count: 250,
    output: join('/tmp', 'spacefolding-generated-tasks.json'),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sources') {
      options.sources = parseSources(readOptionValue(argv, i++, arg));
    } else if (arg === '--count') {
      options.count = parsePositiveInt(readOptionValue(argv, i++, arg), 'count');
    } else if (arg === '--output') {
      options.output = resolveOutput(readOptionValue(argv, i++, arg));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
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

function parseSources(value: string): string[] {
  const sources = value
    .split(',')
    .map((source) => source.trim())
    .filter((source) => source.length > 0)
    .map((source) => source.startsWith('/') ? source : join(projectRoot, source));

  if (sources.length === 0) {
    throw new Error('--sources requires at least one path');
  }

  return sources;
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function resolveOutput(output: string): string {
  return output.startsWith('/') ? output : join(projectRoot, output);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Main ─────────────────────────────────────────────────────────

function main() {
  const options = parseArgs(process.argv.slice(2));

  // Load expert tasks from dataset.json
  const expertPath = join(benchDir, 'dataset.json');
  const expertData: { tasks: ExpertTask[] } = JSON.parse(
    readFileSync(expertPath, 'utf-8')
  );

  // Also load fixture expert tasks if present
  const fixtureExpertPath = join(benchDir, 'fixtures', 'dataset.json');
  let fixtureExpertTasks: ExpertTask[] = [];
  if (existsSync(fixtureExpertPath)) {
    const fixtureData: { tasks: ExpertTask[] } = JSON.parse(
      readFileSync(fixtureExpertPath, 'utf-8')
    );
    fixtureExpertTasks = fixtureData.tasks;
  }

  // Generate synthetic tasks from all source directories
  const generatedTasks = generateTasks(options.sources, projectRoot);

  // Combine: all expert tasks + generated
  const allTasks: Task[] = [
    ...expertData.tasks.map((t): Task => ({
      ...t,
      difficulty: 'hard' as const,
      source: 'expert' as const,
    })),
    ...fixtureExpertTasks.map((t): Task => ({
      ...t,
      difficulty: 'hard' as const,
      source: 'expert' as const,
    })),
    ...generatedTasks,
  ];

  // Deduplicate by task text (keep expert version)
  const seen = new Set<string>();
  const deduped = allTasks.filter(t => {
    const key = t.task.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Balance intents and cap at count
  const targetPerIntent = Math.ceil(options.count / INTENTS.length);

  // Group by intent, preserving expert tasks always
  const byIntent = new Map<string, Task[]>();
  for (const intent of INTENTS) byIntent.set(intent, []);
  for (const task of deduped) {
    byIntent.get(task.intent)!.push(task);
  }

  // Within each intent bucket: expert tasks first, then fill from generated
  const balanced: Task[] = [];
  for (const intent of INTENTS) {
    const bucket = byIntent.get(intent)!;
    const experts = bucket.filter(t => t.source === 'expert');
    const generated = bucket.filter(t => t.source === 'generated');
    balanced.push(...experts);
    const remaining = targetPerIntent - experts.length;
    if (remaining > 0) {
      balanced.push(...generated.slice(0, remaining));
    }
  }

  // Re-number IDs after balancing
  for (let i = 0; i < balanced.length; i++) {
    const t = balanced[i];
    if (t.source === 'generated') {
      t.id = `G${String(i + 1).padStart(3, '0')}`;
    }
  }

  // Hard cap
  const capped = balanced.slice(0, options.count);

  // Stats
  const stats = {
    total: capped.length,
    expert: capped.filter(t => t.source === 'expert').length,
    generated: capped.filter(t => t.source === 'generated').length,
    byIntent: {} as Record<string, number>,
    byDifficulty: { easy: 0, medium: 0, hard: 0 } as Record<string, number>,
  };

  for (const t of capped) {
    stats.byIntent[t.intent] = (stats.byIntent[t.intent] ?? 0) + 1;
    stats.byDifficulty[t.difficulty]++;
  }

  writeFileSync(options.output, JSON.stringify({ tasks: capped }, null, 2));

  console.log(`Generated ${options.output}`);
  console.log(`Sources: ${options.sources.join(', ')}`);
  console.log(JSON.stringify(stats, null, 2));
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  try {
    main();
  } catch (error) {
    console.error(`Task generation failed: ${errorMessage(error)}`);
    process.exit(1);
  }
}
