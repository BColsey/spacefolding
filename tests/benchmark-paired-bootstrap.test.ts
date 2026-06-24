import { describe, expect, it } from 'vitest';
import { splitPair } from '../benchmarks/paired-bootstrap.js';

// The 8 strategies emitted by evaluate.ts ALL_STRATEGIES. Two of them
// (`path-match`, `symbol-only`) contain hyphens — the regression source.
const STRATS = new Set([
  'keyword', 'bm25', 'bm25body', 'path-match', 'fts', 'vector', 'symbol-only', 'structural',
]);

describe('paired-bootstrap splitPair', () => {
  it('splits a contrast between two single-token strategies', () => {
    expect(splitPair('structural-fts', STRATS)).toEqual(['structural', 'fts']);
    expect(splitPair('structural-vector', STRATS)).toEqual(['structural', 'vector']);
    expect(splitPair('bm25-bm25body', STRATS)).toEqual(['bm25', 'bm25body']);
  });

  it('splits correctly when the right-hand strategy contains a hyphen (the regression)', () => {
    // The old `pair.split('-')` mis-split these into non-existent strategies
    // `path` / `symbol`, which then threw `strategy path not in report`.
    expect(splitPair('structural-path-match', STRATS)).toEqual(['structural', 'path-match']);
    expect(splitPair('structural-symbol-only', STRATS)).toEqual(['structural', 'symbol-only']);
  });

  it('splits correctly when both strategies contain hyphens', () => {
    expect(splitPair('path-match-symbol-only', STRATS)).toEqual(['path-match', 'symbol-only']);
  });

  it('throws a clear error when no split yields two known strategies', () => {
    expect(() => splitPair('structural-bogus', STRATS)).toThrow(/no '-' split yields two known/);
    // Two hyphens but neither split is valid: structural|fts-vector and structural-fts|vector.
    expect(() => splitPair('structural-fts-vector', STRATS)).toThrow(/no '-' split yields two known/);
  });

  it('throws when the contrast has no separator', () => {
    expect(() => splitPair('structural', STRATS)).toThrow(/no '-' separator/);
  });

  it('throws on a genuinely ambiguous contrast (multiple valid splits)', () => {
    // known {p, q, p-q, q-r, r}: 'p-q-r' splits validly as p|q-r AND p-q|r.
    const known = new Set(['p', 'q', 'p-q', 'q-r', 'r']);
    expect(() => splitPair('p-q-r', known)).toThrow(/ambiguous/);
  });
});
