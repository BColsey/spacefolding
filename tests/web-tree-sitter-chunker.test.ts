import { describe, it, expect } from 'vitest';
import { buildChunksFromSymbolRanges } from '../src/core/tree-sitter-chunker.js';
import {
  splitCodeWithWebTreeSitter,
  webTreeSitterAvailable,
  resetWebTreeSitterChunker,
} from '../src/core/web-tree-sitter-chunker.js';
import { DeterministicTokenEstimator } from '../src/providers/token-estimator.js';

const estimator = new DeterministicTokenEstimator();

// A synthetic Python-ish file with three top-level blocks; long enough to split.
function pyFile(): string {
  const body = (name: string) =>
    `def ${name}(value):\n` +
    Array.from({ length: 30 }, (_, i) => `    step_${i} = transform(value, ${i})`).join('\n') +
    `\n    return step_0\n`;
  return `import os\nimport sys\n\n${body('alpha')}\n${body('beta')}\n${body('gamma')}\n`;
}

describe('buildChunksFromSymbolRanges (shared AST→chunk machinery, no WASM)', () => {
  it('returns null when there are no symbol ranges', () => {
    expect(buildChunksFromSymbolRanges('x = 1\n', [], 50, 0, estimator)).toBeNull();
  });

  it('splits along the provided top-level boundaries and keeps the import prefix', () => {
    const text = pyFile();
    const lines = text.split('\n');
    // Locate the three def lines as 1-based boundaries; endLine is exclusive 0-based.
    const defLines = lines
      .map((l, i) => ({ l, i }))
      .filter((x) => x.l.startsWith('def '))
      .map((x) => x.i); // 0-based indices of `def`
    const ranges = defLines.map((start, idx) => ({
      startLine: start + 1,
      endLine: (defLines[idx + 1] ?? lines.length), // exclusive 0-based end
    }));

    const pieces = buildChunksFromSymbolRanges(text, ranges, 250, 0, estimator);
    expect(pieces).not.toBeNull();
    expect(pieces!.length).toBeGreaterThan(1);
    // Every piece should carry the import prefix (shared-prefix behavior).
    for (const piece of pieces!) {
      expect(piece).toContain('import os');
    }
    // No piece should begin mid-body (an indented continuation line).
    for (const piece of pieces!) {
      const firstLine = piece.split('\n').find((l) => l.trim().length > 0) ?? '';
      expect(/^\s/.test(firstLine)).toBe(false);
    }
  });
});

describe('splitCodeWithWebTreeSitter (pure-JS AST, graceful when WASM absent)', () => {
  it('returns null for an unsupported language without throwing', async () => {
    resetWebTreeSitterChunker();
    const result = await splitCodeWithWebTreeSitter('SELECT 1;', 50, 0, estimator, 'sql');
    expect(result).toBeNull();
  });

  it('never throws and falls back to null when WASM deps are unavailable', async () => {
    resetWebTreeSitterChunker();
    const text = pyFile();
    // Must not throw regardless of whether web-tree-sitter is installed.
    const result = await splitCodeWithWebTreeSitter(text, 250, 0, estimator, 'python');
    if (!webTreeSitterAvailable()) {
      expect(result).toBeNull();
      return;
    }
    // When the optional WASM deps ARE present, it should split at AST boundaries.
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(1);
    for (const piece of result!) {
      const firstLine = piece.split('\n').find((l) => l.trim().length > 0) ?? '';
      // No chunk should begin mid-body (functions are not split mid-body).
      expect(/^\s/.test(firstLine)).toBe(false);
    }
  });
});
