import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../benchmarks/generate-tasks.ts';

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
});
