import { describe, expect, it } from 'vitest';
import { parseArgs } from '../benchmarks/profile-retrieval.ts';

describe('retrieval profiler CLI parsing', () => {
  it('parses profiler arguments without executing the benchmark on import', () => {
    expect(parseArgs([
      '--corpus',
      '/tmp/corpus',
      '--dataset',
      '/tmp/tasks.json',
      '--strategy',
      'hybrid',
      '--top-k',
      '25',
      '--return-limit',
      '8',
      '--max-tokens',
      '12000',
      '--json',
      '--include-tests',
    ])).toMatchObject({
      corpus: '/tmp/corpus',
      dataset: '/tmp/tasks.json',
      strategy: 'hybrid',
      topK: 25,
      returnLimit: 8,
      maxTokens: 12000,
      json: true,
      includeTests: true,
    });
  });

  it('rejects invalid profiler arguments directly', () => {
    expect(() => parseArgs(['--strategy', 'bogus'])).toThrow(
      '--strategy must be one of: structural, hybrid, vector, text, graph'
    );
    expect(() => parseArgs(['--top-k', '0'])).toThrow(
      '--top-k must be a positive integer'
    );
    expect(() => parseArgs(['--return-limit', '1.5'])).toThrow(
      '--return-limit must be a positive integer'
    );
    expect(() => parseArgs(['--max-tokens', '12000abc'])).toThrow(
      '--max-tokens must be a positive integer'
    );
    expect(() => parseArgs(['--dataset', '--json'])).toThrow(
      '--dataset requires a value'
    );
    expect(() => parseArgs(['--unknown'])).toThrow(
      'Unknown argument: --unknown'
    );
  });
});
