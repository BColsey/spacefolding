import { describe, it, expect } from 'vitest';
import { maybeSplit, DEFAULT_CHUNKING_CONFIG } from '../src/core/chunker.js';
import { DeterministicTokenEstimator } from '../src/providers/token-estimator.js';

const estimator = new DeterministicTokenEstimator();
const config = { ...DEFAULT_CHUNKING_CONFIG, maxTokens: 100, overlapTokens: 10 };

function tsFunction(name: string, word: string): string {
  const rows = Array.from({ length: 8 }, (_, index) => `    '${word}-${index}',`);
  return `export function ${name}() {\n  return [\n${rows.join('\n')}\n  ].join(' ');\n}`;
}

describe('ContextChunker', () => {
  it('returns null for text that fits within maxTokens', () => {
    const shortText = 'Hello world';
    const result = maybeSplit(shortText, estimator.estimate(shortText), config, estimator, {
      source: 'test',
    });
    expect(result).toBeNull();
  });

  it('splits long text into multiple children', () => {
    const longText = Array(50).fill('This is a test sentence with enough words to use tokens.').join('\n\n');
    const result = maybeSplit(longText, estimator.estimate(longText), config, estimator, {
      source: 'test',
    });
    expect(result).not.toBeNull();
    expect(result!.children.length).toBeGreaterThan(1);
    expect(result!.parent.childrenIds.length).toBe(result!.children.length);
    for (const child of result!.children) {
      expect(child.parentId).toBe(result!.parent.id);
      expect(estimator.estimate(child.text)).toBeLessThanOrEqual(config.maxTokens + config.overlapTokens + 50);
    }
  });

  it('uses code strategy for .ts files', () => {
    const code = [
      'import { foo } from "bar";',
      '',
      ...Array(30).fill(null).map((_, i) => `function func${i}() {\n  return ${i};\n}`),
    ].join('\n');
    const result = maybeSplit(code, estimator.estimate(code), config, estimator, {
      source: 'file',
      path: 'src/test.ts',
      language: 'typescript',
    });
    expect(result).not.toBeNull();
    expect(result!.parent.metadata.strategy).toBe('code');
    // Each chunk should start with imports
    for (const child of result!.children) {
      expect(child.text).toContain('import { foo }');
    }
  });

  it('splits large TypeScript files at top-level declaration boundaries when possible', () => {
    const codeConfig = { ...DEFAULT_CHUNKING_CONFIG, maxTokens: 80, overlapTokens: 0 };
    const code = [
      'import { helper } from "./helper";',
      '',
      tsFunction('alphaBoundary', 'alpha'),
      '',
      tsFunction('betaBoundary', 'beta'),
      '',
      tsFunction('gammaBoundary', 'gamma'),
    ].join('\n');

    const result = maybeSplit(code, estimator.estimate(code), codeConfig, estimator, {
      source: 'file',
      path: 'src/boundaries.ts',
      language: 'typescript',
    });

    expect(result).not.toBeNull();
    expect(result!.parent.metadata.strategy).toBe('code');
    expect(result!.children).toHaveLength(3);
    expect(result!.children[0].text).toContain('alphaBoundary');
    expect(result!.children[0].text).not.toContain('betaBoundary');
    expect(result!.children[1].text).toContain('betaBoundary');
    expect(result!.children[1].text).not.toContain('gammaBoundary');
    expect(result!.children[2].text).toContain('gammaBoundary');
    for (const child of result!.children) {
      expect(child.text.startsWith('import { helper }')).toBe(true);
      expect(child.tokensEstimate).toBeLessThanOrEqual(codeConfig.maxTokens);
    }
  });

  it('uses markdown strategy for .md files', () => {
    const md = [
      '# Main Title',
      '',
      'Intro paragraph.',
      '',
      ...Array(20).fill(null).map((_, i) => `## Section ${i}\n\nContent for section ${i}.`),
    ].join('\n');
    const result = maybeSplit(md, estimator.estimate(md), config, estimator, {
      source: 'file',
      path: 'docs/test.md',
    });
    expect(result).not.toBeNull();
    expect(result!.parent.metadata.strategy).toBe('markdown');
  });

  it('preserves type and path on children', () => {
    const longText = Array(100).fill('Sentence that repeats enough to trigger the splitting process. Another line.').join('\n\n');
    const result = maybeSplit(longText, estimator.estimate(longText), config, estimator, {
      source: 'file',
      type: 'fact',
      path: 'src/app.ts',
      language: 'typescript',
    });
    expect(result).not.toBeNull();
    for (const child of result!.children) {
      expect(child.path).toBe('src/app.ts');
      expect(child.language).toBe('typescript');
    }
  });

  it('parent metadata includes split info', () => {
    const longText = Array(50).fill('More text to exceed the max token limit.').join('\n\n');
    const result = maybeSplit(longText, estimator.estimate(longText), config, estimator, {
      source: 'test',
    });
    expect(result).not.toBeNull();
    expect(result!.parent.metadata.split).toBe(true);
    expect(result!.parent.metadata.childCount).toBe(result!.children.length);
    expect(result!.parent.metadata.contentHash).toMatch(/^[a-f0-9]{16}$/);
    for (const [index, child] of result!.children.entries()) {
      expect(child.parentId).toBe(result!.parent.id);
      expect(child.metadata.splitIndex).toBe(index);
      expect(child.metadata.splitTotal).toBe(result!.children.length);
      expect(child.metadata.contentHash).toMatch(/^[a-f0-9]{16}$/);
    }
  });
});
