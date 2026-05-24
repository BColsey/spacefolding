import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs, validateGeneratedTasksOutputPath } from '../benchmarks/generate-tasks.ts';

const generatedPaths: string[] = [];

afterEach(() => {
  for (const filePath of generatedPaths.splice(0)) {
    if (existsSync(filePath)) rmSync(filePath, { recursive: true, force: true });
  }
});

describe('benchmark task generator CLI parsing', () => {
  it('imports without generating tasks and defaults output to /tmp', () => {
    const options = parseArgs([]);

    expect(options).toMatchObject({
      sources: [
        join(process.cwd(), 'src'),
        join(process.cwd(), 'benchmarks', 'fixtures'),
      ],
      count: 250,
      output: join('/tmp', 'spacefolding-generated-tasks.json'),
    });
  });

  it('parses source, count, and output options consistently', () => {
    expect(parseArgs([
      '--sources',
      'src,/tmp/other-corpus',
      '--count',
      '25',
      '--output',
      '/tmp/generated-tasks.json',
    ])).toEqual({
      sources: [
        join(process.cwd(), 'src'),
        '/tmp/other-corpus',
      ],
      count: 25,
      output: '/tmp/generated-tasks.json',
    });
  });

  it('rejects malformed generator arguments before writing output', () => {
    expect(() => parseArgs(['--count', '0'])).toThrow(
      '--count must be a positive integer'
    );
    expect(() => parseArgs(['--count', '1.5'])).toThrow(
      '--count must be a positive integer'
    );
    expect(() => parseArgs(['--sources', '--count'])).toThrow(
      '--sources requires a value'
    );
    expect(() => parseArgs(['--output', '--count'])).toThrow(
      '--output requires a value'
    );
    expect(() => parseArgs(['--unknown'])).toThrow(
      'Unknown argument: --unknown'
    );
  });

  it('refuses to write generated task JSON outside /tmp or inside the repository', () => {
    expect(() => parseArgs(['--output', 'benchmarks/generated-tasks.json'])).toThrow(
      /Refusing to write generated benchmark tasks inside the repository/
    );
    expect(() => parseArgs(['--output', '/var/tmp/generated-tasks.json'])).toThrow(
      /Refusing to write generated benchmark tasks outside \/tmp/
    );
  });

  it('refuses output paths whose /tmp parent resolves back into the repository', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spacefolding-generated-tasks-symlink-'));
    generatedPaths.push(tempDir);
    const repoLink = join(tempDir, 'repo-link');
    symlinkSync(process.cwd(), repoLink, 'dir');

    expect(() => validateGeneratedTasksOutputPath(join(repoLink, 'generated-tasks.json'))).toThrow(
      /Refusing to write generated benchmark tasks inside the repository/
    );
  });
});
