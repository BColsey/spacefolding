import { lstatSync, readdirSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

export const DEFAULT_BENCHMARK_SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.rs',
  '.go',
  '.java',
];

export const DEFAULT_BENCHMARK_SKIP_DIRS = [
  '.cache',
  '.claude',
  '.codex',
  '.cursor',
  '.git',
  '.hg',
  '.mypy_cache',
  '.next',
  '.pytest_cache',
  '.ruff_cache',
  '.svn',
  '.tox',
  '.turbo',
  '.venv',
  '__pycache__',
  'benchmarks',
  'build',
  'coverage',
  'data',
  'deps',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
  'venv',
];

export interface WalkBenchmarkSourceOptions {
  includeTests?: boolean;
  extensions?: Iterable<string>;
  extraFileNames?: Iterable<string>;
  skipDirs?: Iterable<string>;
}

export function walkBenchmarkSourceFiles(
  dir: string,
  options: WalkBenchmarkSourceOptions = {}
): string[] {
  const includeTests = options.includeTests ?? false;
  const extensions = new Set(
    [...(options.extensions ?? DEFAULT_BENCHMARK_SOURCE_EXTENSIONS)].map((ext) =>
      ext.toLowerCase()
    )
  );
  const extraFileNames = new Set(
    [...(options.extraFileNames ?? [])].map((fileName) => fileName.toLowerCase())
  );
  const skipDirs = new Set(
    [...(options.skipDirs ?? DEFAULT_BENCHMARK_SKIP_DIRS)].map((entry) =>
      entry.toLowerCase()
    )
  );

  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (!skipDirs.has(entry.toLowerCase())) {
        results.push(...walkBenchmarkSourceFiles(fullPath, options));
      }
      continue;
    }

    const fileName = entry.toLowerCase();
    const isSourceFile =
      extensions.has(extname(entry).toLowerCase()) ||
      extraFileNames.has(fileName);
    if (isSourceFile && (includeTests || !isBenchmarkTestPath(fullPath))) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

export function isBenchmarkTestPath(filePath: string): boolean {
  const normalized = filePath.split(/[\\/]+/).join('/');
  return /(^|\/)(__tests__|tests?|spec|fixtures|mocks?)(\/|$)/i.test(normalized)
    || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(normalized)
    || /test_.*\.py$/i.test(normalized)
    || /_test\.go$/i.test(normalized);
}

export function projectRelativePath(projectRoot: string, filePath: string): string {
  return relative(projectRoot, filePath).split(sep).join('/');
}
