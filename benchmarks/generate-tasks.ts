/**
 * Benchmark Task Generator
 *
 * Auto-generates benchmark tasks from source files by extracting
 * symbols (functions, classes, interfaces, exports) and creating
 * realistic queries with those symbols as ground truth.
 *
 * Usage:
 *   npx tsx benchmarks/generate-tasks.ts [--output dataset-large.json]
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Intent templates for generating queries
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

// Extract symbols from TypeScript source
function extractSymbols(content: string, filePath: string): { name: string; kind: string }[] {
  const symbols: { name: string; kind: string }[] = [];

  // Export declarations
  const exportMatches = content.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g);
  for (const m of exportMatches) symbols.push({ name: m[1], kind: 'function' });

  const exportClassMatches = content.matchAll(/export\s+(?:abstract\s+)?class\s+(\w+)/g);
  for (const m of exportClassMatches) symbols.push({ name: m[1], kind: 'class' });

  const exportInterfaceMatches = content.matchAll(/export\s+interface\s+(\w+)/g);
  for (const m of exportInterfaceMatches) symbols.push({ name: m[1], kind: 'interface' });

  const exportTypeMatches = content.matchAll(/export\s+type\s+(\w+)/g);
  for (const m of exportTypeMatches) symbols.push({ name: m[1], kind: 'type' });

  const exportConstMatches = content.matchAll(/export\s+const\s+(\w+)/g);
  for (const m of exportConstMatches) symbols.push({ name: m[1], kind: 'constant' });

  return symbols;
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (!['node_modules', '.git', 'dist'].includes(entry)) results.push(...walkDir(fullPath));
    } else if (extname(entry) === '.ts') results.push(fullPath);
  }
  return results;
}

function generateTasks(srcDir: string): Task[] {
  const files = walkDir(srcDir);
  const tasks: Task[] = [];
  let taskId = 0;

  // Map file paths to relative paths
  const fileMap = new Map<string, string>();
  for (const filePath of files) {
    const relativePath = filePath.replace(/.*\/spacefolding\//, '');
    fileMap.set(filePath, relativePath);
  }

  const allRelativePaths = [...fileMap.values()];

  for (const filePath of files) {
    const relativePath = fileMap.get(filePath)!;
    const content = readFileSync(filePath, 'utf-8');
    const symbols = extractSymbols(content, relativePath);

    for (const symbol of symbols) {
      const intents = Object.keys(TEMPLATES);
      const intent = intents[Math.floor(Math.random() * intents.length)];
      const templates = TEMPLATES[intent];
      const template = templates[Math.floor(Math.random() * templates.length)];

      const query = template
        .replace('{symbol}', symbol.name)
        .replace('{kind}', symbol.kind);

      // Determine difficulty based on number of relevant files
      // The primary file is always relevant; add cross-references for harder tasks
      const relevantFiles = [relativePath];
      const difficulty: Task['difficulty'] = ['easy', 'medium', 'hard'][Math.floor(Math.random() * 3)] as Task['difficulty'];

      if (difficulty === 'medium') {
        // Add 1-2 files from the same directory
        const sameDir = allRelativePaths.filter(p =>
          p !== relativePath && dirname(p) === dirname(relativePath)
        );
        const extra = sameDir.sort(() => Math.random() - 0.5).slice(0, Math.min(2, sameDir.length));
        relevantFiles.push(...extra);
      } else if (difficulty === 'hard') {
        // Add 2-4 files from anywhere
        const others = allRelativePaths.filter(p => p !== relativePath);
        const extra = others.sort(() => Math.random() - 0.5).slice(0, Math.min(4, others.length));
        relevantFiles.push(...extra);
      }

      // Extract keywords from the symbol and query
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

  return tasks;
}

function main() {
  const benchDir = dirname(fileURLToPath(import.meta.url));
  const srcDir = join(benchDir, '..', 'src');

  // Load expert tasks
  const expertData: { tasks: ExpertTask[] } = JSON.parse(
    readFileSync(join(benchDir, 'dataset.json'), 'utf-8')
  );

  // Generate synthetic tasks
  const generatedTasks = generateTasks(srcDir);

  // Combine
  const allTasks: Task[] = [
    ...expertData.tasks.map((t): Task => ({
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

  // Stats
  const stats = {
    total: deduped.length,
    expert: deduped.filter(t => t.source === 'expert').length,
    generated: deduped.filter(t => t.source === 'generated').length,
    byIntent: {} as Record<string, number>,
    byDifficulty: { easy: 0, medium: 0, hard: 0 } as Record<string, number>,
  };

  for (const t of deduped) {
    stats.byIntent[t.intent] = (stats.byIntent[t.intent] ?? 0) + 1;
    stats.byDifficulty[t.difficulty]++;
  }

  const outputPath = join(benchDir, 'dataset-large.json');
  writeFileSync(outputPath, JSON.stringify({ tasks: deduped }, null, 2));

  console.log(`Generated ${outputPath}`);
  console.log(JSON.stringify(stats, null, 2));
}

main();
