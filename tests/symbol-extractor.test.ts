import { describe, expect, it } from 'vitest';
import { extractSymbols } from '../src/providers/symbol-extractor.js';

describe('extractSymbols', () => {
  it('matches function declarations', () => {
    const symbols = extractSymbols('function authenticate(token: string) { return token; }', 'typescript');
    expect(symbols).toEqual([
      { name: 'authenticate', kind: 'function', line: 1, filePath: undefined },
    ]);
  });

  it('does not match for loops as methods', () => {
    const symbols = extractSymbols('for (let i = 0; i < 10; i++) { console.log(i); }', 'typescript');
    expect(symbols).toEqual([]);
  });

  it('does not match if statements as methods', () => {
    const symbols = extractSymbols('if (condition) { doWork(); }', 'typescript');
    expect(symbols).toEqual([]);
  });

  it('matches class declarations', () => {
    const symbols = extractSymbols('class MyService {}', 'typescript');
    expect(symbols).toEqual([
      { name: 'MyService', kind: 'class', line: 1, filePath: undefined },
    ]);
  });

  it('matches variable declarations', () => {
    const symbols = extractSymbols('const myVar = 5;', 'typescript');
    expect(symbols).toEqual([
      { name: 'myVar', kind: 'variable', line: 1, filePath: undefined },
    ]);
  });

  it('matches python function declarations', () => {
    const symbols = extractSymbols('def my_function():\n    return 1\n', 'python');
    expect(symbols).toEqual([
      { name: 'my_function', kind: 'function', line: 1, filePath: undefined },
    ]);
  });

  it('returns empty symbols for empty input', () => {
    expect(extractSymbols('', 'typescript')).toEqual([]);
  });
});
