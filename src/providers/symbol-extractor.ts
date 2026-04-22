import type { ContextChunk } from '../types/index.js';

export interface SymbolInfo {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'method';
  line: number;
  filePath?: string;
}

const CONTROL_FLOW_NAME = '(?!for\\b|if\\b|while\\b|switch\\b|catch\\b|return\\b|throw\\b|else\\b|try\\b|do\\b)';

const JAVASCRIPT_PATTERNS: Array<{ regex: RegExp; kind: SymbolInfo['kind'] }> = [
  {
    regex: new RegExp(
      `^(?:export\\s+)?(?:async\\s+)?function\\s+${CONTROL_FLOW_NAME}([A-Za-z_$][\\w$]*)\\s*\\(`,
      'gm'
    ),
    kind: 'function',
  },
  { regex: /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/gm, kind: 'class' },
  { regex: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/gm, kind: 'interface' },
  { regex: /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/gm, kind: 'type' },
  { regex: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm, kind: 'variable' },
  {
    regex: new RegExp(
      `^\\s*(?:public\\s+|private\\s+|protected\\s+|static\\s+|readonly\\s+|async\\s+|get\\s+|set\\s+)*${CONTROL_FLOW_NAME}([A-Za-z_$][\\w$]*)\\s*\\([^\\n;]*\\)\\s*\\{`,
      'gm'
    ),
    kind: 'method',
  },
];

const PYTHON_PATTERNS: Array<{ regex: RegExp; kind: SymbolInfo['kind'] }> = [
  {
    regex: new RegExp(`^\\s*(?:async\\s+)?def\\s+${CONTROL_FLOW_NAME}([A-Za-z_][\\w]*)\\s*\\(`, 'gm'),
    kind: 'function',
  },
  { regex: /^\s*class\s+([A-Za-z_][\w]*)\b/gm, kind: 'class' },
];

export function extractSymbols(
  text: string,
  language?: string,
  filePath?: string
): SymbolInfo[] {
  const normalizedLanguage = language?.toLowerCase();
  if (normalizedLanguage === 'typescript' || normalizedLanguage === 'javascript') {
    return extractWithPatterns(text, JAVASCRIPT_PATTERNS, filePath);
  }
  if (normalizedLanguage === 'python') {
    return extractWithPatterns(text, PYTHON_PATTERNS, filePath);
  }
  return [];
}

export function buildSymbolIndex(chunks: ContextChunk[]): Map<string, SymbolInfo[]> {
  const index = new Map<string, SymbolInfo[]>();

  for (const chunk of chunks) {
    if (chunk.type !== 'code') continue;
    index.set(chunk.id, extractSymbols(chunk.text, chunk.language, chunk.path));
  }

  return index;
}

function extractWithPatterns(
  text: string,
  patterns: Array<{ regex: RegExp; kind: SymbolInfo['kind'] }>,
  filePath?: string
): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const seen = new Set<string>();

  for (const { regex, kind } of patterns) {
    for (const match of text.matchAll(regex)) {
      const name = match[1];
      const index = match.index ?? 0;
      const line = getLineNumber(text, index);
      const lineText = text.split(/\r?\n/)[line - 1] ?? '';

      if (kind === 'method' && /\b(function|class)\b/.test(lineText)) {
        continue;
      }

      const key = `${kind}:${name}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({ name, kind, line, filePath });
    }
  }

  return symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

function getLineNumber(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}
