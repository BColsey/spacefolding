import { describe, it, expect } from 'vitest';
import { classifyChunk } from '../src/core/classifier.js';

describe('classifyChunk', () => {
  it('classifies diff text as diff', () => {
    expect(classifyChunk('diff --git a/file.ts b/file.ts\n--- a/file.ts', 'git')).toBe('diff');
  });

  it('classifies diff source as diff', () => {
    expect(classifyChunk('some changes', 'diff')).toBe('diff');
  });

  it('classifies log text as log', () => {
    expect(classifyChunk('2024-01-15 10:30:00 ERROR Failed to connect', 'output')).toBe('log');
  });

  it('classifies log source as log', () => {
    expect(classifyChunk('something happened', 'log')).toBe('log');
  });

  it('classifies summary source as summary', () => {
    expect(classifyChunk('Previous work summary', 'summary')).toBe('summary');
  });

  it('classifies reference source as reference', () => {
    expect(classifyChunk('API documentation', 'reference')).toBe('reference');
  });

  it('classifies doc source as reference', () => {
    expect(classifyChunk('Documentation text', 'doc')).toBe('reference');
  });

  it('classifies imperative conversation as constraint', () => {
    expect(classifyChunk('Must implement authentication for all endpoints', 'conversation')).toBe('constraint');
  });

  it('classifies "ensure" as constraint', () => {
    expect(classifyChunk('Ensure all tests pass before merging', 'conversation')).toBe('constraint');
  });

  it('classifies action verb conversation as instruction', () => {
    expect(classifyChunk('Fix the login bug in auth.ts', 'conversation')).toBe('instruction');
  });

  it('classifies "implement" as instruction', () => {
    expect(classifyChunk('Implement rate limiting for the API', 'conversation')).toBe('instruction');
  });

  it('classifies code-like file content as code', () => {
    expect(classifyChunk('function authenticate(user: string) { return true; }', 'file')).toBe('code');
  });

  it('classifies default conversation as fact', () => {
    expect(classifyChunk('The sky is blue today', 'conversation')).toBe('fact');
  });

  it('classifies unknown source default as fact', () => {
    expect(classifyChunk('Some random text', 'unknown')).toBe('fact');
  });
});
