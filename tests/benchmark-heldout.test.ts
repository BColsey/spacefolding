import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseArgs,
  validateHeldoutOutputPath,
  writeHeldoutDataset,
  type HeldoutDataset,
} from '../benchmarks/generate-heldout.ts';

const generatedFiles: string[] = [];

afterEach(() => {
  for (const filePath of generatedFiles.splice(0)) {
    if (existsSync(filePath)) rmSync(filePath);
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
    generatedFiles.push(output);

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
});
