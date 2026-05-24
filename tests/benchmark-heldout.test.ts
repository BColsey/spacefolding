import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseArgs,
  validateHeldoutOutputPath,
  writeHeldoutDataset,
  type HeldoutDataset,
} from '../benchmarks/generate-heldout.ts';

const generatedPaths: string[] = [];

afterEach(() => {
  for (const filePath of generatedPaths.splice(0)) {
    if (existsSync(filePath)) rmSync(filePath, { recursive: true, force: true });
  }
});

describe('held-out benchmark dataset generator', () => {
  it('defaults generated datasets to /tmp artifacts', () => {
    const options = parseArgs([]);

    expect(options.output).toBe(join('/tmp', 'spacefolding-heldout-dataset.json'));
  });

  it('refuses to write generated datasets inside the repository checkout', () => {
    const repoOutput = join(process.cwd(), 'benchmarks', 'heldout-dataset.json');

    expect(() => validateHeldoutOutputPath(repoOutput)).toThrow(
      /Refusing to write generated held-out dataset inside the repository/
    );
  });

  it('refuses to write generated datasets outside /tmp', () => {
    expect(() => validateHeldoutOutputPath('/var/tmp/spacefolding-heldout-dataset.json')).toThrow(
      /Refusing to write generated held-out dataset outside \/tmp/
    );
  });

  it('refuses output paths whose /tmp parent resolves back into the repository', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spacefolding-heldout-symlink-'));
    generatedPaths.push(tempDir);
    const repoLink = join(tempDir, 'repo-link');
    symlinkSync(process.cwd(), repoLink, 'dir');

    expect(() => validateHeldoutOutputPath(join(repoLink, 'heldout-dataset.json'))).toThrow(
      /Refusing to write generated held-out dataset inside the repository/
    );
  });

  it('rejects invalid numeric limits before generating held-out tasks', () => {
    expect(() => parseArgs(['--limit', '0'])).toThrow(
      '--limit must be a positive integer'
    );
    expect(() => parseArgs(['--max-per-file', '-1'])).toThrow(
      '--max-per-file must be a positive integer'
    );
    expect(() => parseArgs(['--limit', '1.5'])).toThrow(
      '--limit must be a positive integer'
    );
    expect(() => parseArgs(['--max-per-file', '3abc'])).toThrow(
      '--max-per-file must be a positive integer'
    );
  });

  it('rejects unknown flags and missing option values', () => {
    expect(() => parseArgs(['--output', '--include-tests'])).toThrow(
      '--output requires a value'
    );
    expect(() => parseArgs(['--unknown'])).toThrow(
      'Unknown argument: --unknown'
    );
  });

  it('writes deterministic held-out task metadata under /tmp without source contents', () => {
    const output = join(tmpdir(), `spacefolding-heldout-test-${process.pid}.json`);
    generatedPaths.push(output);

    const options = parseArgs([
      '--corpus',
      join(process.cwd(), 'benchmarks', 'fixtures'),
      '--output',
      output,
      '--limit',
      '5',
      '--seed',
      'vitest-heldout',
      '--include-tests',
    ]);

    const firstSummary = writeHeldoutDataset(options);
    const firstDataset = JSON.parse(readFileSync(output, 'utf-8')) as HeldoutDataset;
    const firstSerialized = JSON.stringify(firstDataset);

    const secondSummary = writeHeldoutDataset(options);
    const secondDataset = JSON.parse(readFileSync(output, 'utf-8')) as HeldoutDataset;

    expect(firstSummary).toMatchObject({
      output,
      corpus: join(process.cwd(), 'benchmarks', 'fixtures'),
      tasks: 5,
    });
    expect(secondSummary).toEqual(firstSummary);
    expect(JSON.stringify(secondDataset)).toBe(firstSerialized);
    expect(firstDataset).toMatchObject({
      generated_at: '1970-01-01T00:00:00.000Z',
      source_file_count: expect.any(Number),
      symbol_count: expect.any(Number),
    });
    expect(firstDataset.tasks).toHaveLength(5);
    expect(firstDataset.tasks.every((task) => task.source === 'heldout-generated')).toBe(true);
    expect(firstDataset.tasks.every((task) => task.relevant_files.length === 1)).toBe(true);
    expect(
      firstDataset.tasks.every((task) =>
        task.relevant_files.every((filePath) => filePath.startsWith('benchmarks/fixtures/'))
      )
    ).toBe(true);
  });

  it('uses evaluator-relative paths and skips dependency, build, and test directories by default', () => {
    const corpus = mkdtempSync(join(tmpdir(), 'spacefolding-heldout-corpus-'));
    const output = join(tmpdir(), `spacefolding-heldout-skip-test-${process.pid}.json`);
    generatedPaths.push(corpus, output);

    const sourcePath = join(corpus, 'src', 'kept.ts');
    mkdirSync(join(corpus, 'src'), { recursive: true });
    mkdirSync(join(corpus, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(corpus, 'dist'), { recursive: true });
    mkdirSync(join(corpus, 'build'), { recursive: true });
    mkdirSync(join(corpus, 'tests'), { recursive: true });
    writeFileSync(sourcePath, 'export function LoadHeldoutProfiles() { return true; }\n');
    writeFileSync(join(corpus, 'node_modules', 'pkg', 'private.ts'), 'export function DependencyOnlySymbol() {}\n');
    writeFileSync(join(corpus, 'dist', 'bundle.ts'), 'export function BuiltOnlySymbol() {}\n');
    writeFileSync(join(corpus, 'build', 'artifact.ts'), 'export function BuildOnlySymbol() {}\n');
    writeFileSync(join(corpus, 'tests', 'sample.test.ts'), 'export function TestOnlySymbol() {}\n');

    const options = parseArgs([
      '--corpus',
      corpus,
      '--output',
      output,
      '--limit',
      '10',
      '--seed',
      'skip-dirs',
    ]);

    const summary = writeHeldoutDataset(options);
    const dataset = JSON.parse(readFileSync(output, 'utf-8')) as HeldoutDataset;
    const expectedPath = relative(process.cwd(), sourcePath).split(sep).join('/');
    const relevantPaths = dataset.tasks.flatMap((task) => task.relevant_files);

    expect(summary.tasks).toBe(1);
    expect(relevantPaths).toEqual([expectedPath]);
    expect(relevantPaths.every((filePath) => !isAbsolute(filePath))).toBe(true);
    expect(JSON.stringify(dataset)).not.toContain('DependencyOnlySymbol');
    expect(JSON.stringify(dataset)).not.toContain('BuiltOnlySymbol');
    expect(JSON.stringify(dataset)).not.toContain('BuildOnlySymbol');
    expect(JSON.stringify(dataset)).not.toContain('TestOnlySymbol');
  });
});
