import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CodeReference,
  CodeReferenceKind,
  CodeSymbol,
  CodeSymbolKind,
} from '../types/index.js';

export interface StructuralExtraction {
  symbols: CodeSymbol[];
  references: CodeReference[];
  backend: 'tree-sitter' | 'regex-fallback';
}

export interface StructuralIndexerOptions {
  python?: string;
  timeoutMs?: number;
  disableSubprocess?: boolean;
}

const SUPPORTED_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'python',
  'rust',
  'go',
  'java',
]);

const CONTROL_WORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'throw',
  'else',
  'try',
  'do',
  'new',
  'function',
  'class',
  'interface',
  'type',
  'const',
  'let',
  'var',
  'pub',
  'fn',
  'func',
]);

export function isSupportedCodeLanguage(language?: string): boolean {
  return language !== undefined && SUPPORTED_LANGUAGES.has(language.toLowerCase());
}

export function normalizeIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_$./:-]/g, '');
}

export function normalizeSymbolName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_$]/g, '');
}

export function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_$./:-]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 1);
}

export class StructuralIndexer {
  private subprocessAvailable: boolean | undefined;

  constructor(private options: StructuralIndexerOptions = {}) {}

  async extract(text: string, language?: string, filePath?: string): Promise<StructuralExtraction> {
    if (!isSupportedCodeLanguage(language)) {
      return { symbols: [], references: [], backend: 'regex-fallback' };
    }

    const normalizedLanguage = language!.toLowerCase();
    if (!this.options.disableSubprocess && process.env.SPACEFOLDING_DISABLE_AST_SUBPROCESS !== '1') {
      const pythonResult = await this.tryPythonExtractor(text, normalizedLanguage, filePath);
      if (pythonResult) return pythonResult;
    }

    return {
      ...extractStructureFallback(text, normalizedLanguage, filePath),
      backend: 'regex-fallback',
    };
  }

  private async tryPythonExtractor(
    text: string,
    language: string,
    filePath?: string
  ): Promise<StructuralExtraction | null> {
    if (this.subprocessAvailable === false) return null;

    const script = findPythonScript();
    if (!script) {
      this.subprocessAvailable = false;
      return null;
    }

    try {
      const result = await runPythonStructuralExtractor(
        this.options.python ?? process.env.PYTHON ?? 'python3',
        script,
        text,
        language,
        filePath,
        this.options.timeoutMs ?? 2000
      );
      this.subprocessAvailable = true;
      return {
        symbols: result.symbols.map((symbol) => normalizeSymbol(symbol, filePath, language)),
        references: result.references.map((reference) => normalizeReference(reference, filePath, language)),
        backend: 'tree-sitter',
      };
    } catch {
      this.subprocessAvailable = false;
      return null;
    }
  }
}

export function extractStructureFallback(
  text: string,
  language?: string,
  filePath?: string
): { symbols: CodeSymbol[]; references: CodeReference[] } {
  const normalizedLanguage = language?.toLowerCase();
  const lines = text.split(/\r?\n/);
  const symbols: CodeSymbol[] = [];
  const references: CodeReference[] = [];
  const seenSymbols = new Set<string>();
  const seenReferences = new Set<string>();

  const addSymbol = (
    name: string,
    kind: CodeSymbolKind,
    index: number,
    signature: string,
    isExported: boolean,
    metadata: Record<string, unknown> = {}
  ) => {
    if (!name || CONTROL_WORDS.has(name)) return;
    const startLine = index + 1;
    const key = `${kind}:${name}:${startLine}`;
    if (seenSymbols.has(key)) return;
    seenSymbols.add(key);
    symbols.push({
      id: randomUUID(),
      path: filePath,
      language: normalizedLanguage,
      name,
      normalizedName: normalizeSymbolName(name),
      kind,
      signature: signature.trim(),
      startLine,
      endLine: findBlockEndLine(lines, index, normalizedLanguage),
      isExported,
      metadata,
    });
  };

  const addReference = (
    target: string,
    kind: CodeReferenceKind,
    index: number,
    metadata: Record<string, unknown> = {}
  ) => {
    const cleanTarget = target.trim();
    if (!cleanTarget) return;
    const startLine = index + 1;
    const key = `${kind}:${cleanTarget}:${startLine}`;
    if (seenReferences.has(key)) return;
    seenReferences.add(key);
    references.push({
      id: randomUUID(),
      path: filePath,
      language: normalizedLanguage,
      target: cleanTarget,
      normalizedTarget: normalizeIdentifier(cleanTarget),
      kind,
      startLine,
      endLine: startLine,
      metadata,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('//') || trimmed.startsWith('#')) continue;

    switch (normalizedLanguage) {
      case 'typescript':
      case 'javascript':
        extractJsLine(trimmed, i, addSymbol, addReference);
        break;
      case 'python':
        extractPythonLine(trimmed, i, addSymbol, addReference);
        break;
      case 'rust':
        extractRustLine(trimmed, i, addSymbol, addReference);
        break;
      case 'go':
        extractGoLine(trimmed, i, addSymbol, addReference);
        break;
      case 'java':
        extractJavaLine(trimmed, i, addSymbol, addReference);
        break;
    }
  }

  return {
    symbols: symbols.sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name)),
    references: references.sort((a, b) => a.startLine - b.startLine || a.target.localeCompare(b.target)),
  };
}

function extractJsLine(
  line: string,
  index: number,
  addSymbol: (name: string, kind: CodeSymbolKind, index: number, signature: string, isExported: boolean, metadata?: Record<string, unknown>) => void,
  addReference: (target: string, kind: CodeReferenceKind, index: number, metadata?: Record<string, unknown>) => void
): void {
  for (const pattern of [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s+['"]([^'"]+)['"]/g,
  ]) {
    for (const match of line.matchAll(pattern)) addReference(match[1], 'import', index);
  }

  const isExported = /\bexport\b/.test(line);
  const functionMatch = line.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (functionMatch) {
    addSymbol(functionMatch[1], 'function', index, line, isExported);
    return;
  }

  const classMatch = line.match(/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)\b/);
  if (classMatch) {
    addSymbol(classMatch[1], 'class', index, line, isExported);
    return;
  }

  const interfaceMatch = line.match(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/);
  if (interfaceMatch) {
    addSymbol(interfaceMatch[1], 'interface', index, line, isExported);
    return;
  }

  const typeMatch = line.match(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/);
  if (typeMatch) {
    addSymbol(typeMatch[1], 'type', index, line, isExported);
    return;
  }

  const variableMatch = line.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/);
  if (variableMatch) {
    const kind: CodeSymbolKind = /=>|\bfunction\b/.test(line) ? 'function' : 'variable';
    addSymbol(variableMatch[1], kind, index, line, isExported);
    return;
  }

  const methodMatch = line.match(/^(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::\s*[^={]+)?\s*\{/);
  if (methodMatch && !CONTROL_WORDS.has(methodMatch[1])) {
    addSymbol(methodMatch[1], 'method', index, line, false);
  }
}

function extractPythonLine(
  line: string,
  index: number,
  addSymbol: (name: string, kind: CodeSymbolKind, index: number, signature: string, isExported: boolean, metadata?: Record<string, unknown>) => void,
  addReference: (target: string, kind: CodeReferenceKind, index: number, metadata?: Record<string, unknown>) => void
): void {
  const fromMatch = line.match(/^from\s+([A-Za-z_][\w.]*|\.+[A-Za-z_][\w.]*)\s+import\s+(.+)/);
  if (fromMatch) addReference(fromMatch[1], 'import', index, { imported: fromMatch[2] });

  const importMatch = line.match(/^import\s+(.+)/);
  if (importMatch) {
    for (const target of importMatch[1].split(',')) {
      addReference(target.replace(/\s+as\s+\w+$/, ''), 'import', index);
    }
  }

  const functionMatch = line.match(/^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/);
  if (functionMatch) {
    addSymbol(functionMatch[1], 'function', index, line, !functionMatch[1].startsWith('_'));
    return;
  }

  const classMatch = line.match(/^class\s+([A-Za-z_][\w]*)\b/);
  if (classMatch) {
    addSymbol(classMatch[1], 'class', index, line, !classMatch[1].startsWith('_'));
  }
}

function extractRustLine(
  line: string,
  index: number,
  addSymbol: (name: string, kind: CodeSymbolKind, index: number, signature: string, isExported: boolean, metadata?: Record<string, unknown>) => void,
  addReference: (target: string, kind: CodeReferenceKind, index: number, metadata?: Record<string, unknown>) => void
): void {
  const useMatch = line.match(/^(?:pub\s+)?use\s+(.+?);?$/);
  if (useMatch) addReference(useMatch[1], 'import', index);

  const modMatch = line.match(/^(?:pub\s+)?mod\s+([A-Za-z_][\w]*)\s*;?/);
  if (modMatch) {
    addSymbol(modMatch[1], 'module', index, line, line.startsWith('pub '));
    addReference(modMatch[1], 'module', index);
    return;
  }

  const symbolMatch = line.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|const|static)\s+([A-Za-z_][\w]*)\b/);
  if (symbolMatch) {
    const kindMap: Record<string, CodeSymbolKind> = {
      fn: 'function',
      struct: 'struct',
      enum: 'enum',
      trait: 'trait',
      const: 'constant',
      static: 'variable',
    };
    addSymbol(symbolMatch[2], kindMap[symbolMatch[1]], index, line, line.startsWith('pub'));
  }
}

function extractGoLine(
  line: string,
  index: number,
  addSymbol: (name: string, kind: CodeSymbolKind, index: number, signature: string, isExported: boolean, metadata?: Record<string, unknown>) => void,
  addReference: (target: string, kind: CodeReferenceKind, index: number, metadata?: Record<string, unknown>) => void
): void {
  const importMatch = line.match(/^import\s+(?:\w+\s+)?["`]([^"`]+)["`]/);
  if (importMatch) addReference(importMatch[1], 'import', index);
  const blockImportMatch = line.match(/^(?:\w+\s+)?["`]([^"`]+)["`]$/);
  if (blockImportMatch) addReference(blockImportMatch[1], 'import', index);

  const methodMatch = line.match(/^func\s+\([^)]*\)\s+([A-Za-z_][\w]*)\s*\(/);
  if (methodMatch) {
    addSymbol(methodMatch[1], 'method', index, line, /^[A-Z]/.test(methodMatch[1]));
    return;
  }

  const functionMatch = line.match(/^func\s+([A-Za-z_][\w]*)\s*\(/);
  if (functionMatch) {
    addSymbol(functionMatch[1], 'function', index, line, /^[A-Z]/.test(functionMatch[1]));
    return;
  }

  const typeMatch = line.match(/^type\s+([A-Za-z_][\w]*)\s+(struct|interface)\b/);
  if (typeMatch) {
    addSymbol(typeMatch[1], typeMatch[2] === 'interface' ? 'interface' : 'struct', index, line, /^[A-Z]/.test(typeMatch[1]));
    return;
  }

  const variableMatch = line.match(/^(?:var|const)\s+([A-Za-z_][\w]*)\b/);
  if (variableMatch) {
    addSymbol(variableMatch[1], line.startsWith('const') ? 'constant' : 'variable', index, line, /^[A-Z]/.test(variableMatch[1]));
  }
}

function extractJavaLine(
  line: string,
  index: number,
  addSymbol: (name: string, kind: CodeSymbolKind, index: number, signature: string, isExported: boolean, metadata?: Record<string, unknown>) => void,
  addReference: (target: string, kind: CodeReferenceKind, index: number, metadata?: Record<string, unknown>) => void
): void {
  const importMatch = line.match(/^import\s+(?:static\s+)?([A-Za-z_][\w.]*\*?)\s*;/);
  if (importMatch) addReference(importMatch[1], 'import', index);

  const classMatch = line.match(/^(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+)*((?:class)|(?:interface)|(?:enum))\s+([A-Za-z_][\w]*)\b/);
  if (classMatch) {
    const kind = classMatch[1] === 'class' ? 'class' : classMatch[1] === 'interface' ? 'interface' : 'enum';
    addSymbol(classMatch[2], kind, index, line, line.startsWith('public '));
    return;
  }

  const methodMatch = line.match(/^(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|synchronized\s+)*[A-Za-z_<>\[\], ?]+\s+([A-Za-z_][\w]*)\s*\([^;]*\)\s*(?:throws\s+[^{]+)?\{/);
  if (methodMatch && !CONTROL_WORDS.has(methodMatch[1])) {
    addSymbol(methodMatch[1], 'method', index, line, line.startsWith('public '));
  }
}

function findBlockEndLine(lines: string[], startIndex: number, language?: string): number {
  const startLine = lines[startIndex] ?? '';
  if (language === 'python' && /^\s*(?:async\s+)?(?:def|class)\s+/.test(startLine)) {
    const startIndent = leadingSpaces(startLine);
    for (let i = startIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().length === 0) continue;
      if (leadingSpaces(line) <= startIndent) return i;
    }
    return lines.length;
  }

  let depth = 0;
  let sawBrace = false;
  for (let i = startIndex; i < lines.length; i++) {
    for (const char of lines[i]) {
      if (char === '{') {
        depth++;
        sawBrace = true;
      } else if (char === '}') {
        depth--;
      }
    }
    if (sawBrace && depth <= 0) return i + 1;
  }
  return startIndex + 1;
}

function leadingSpaces(value: string): number {
  return value.length - value.trimStart().length;
}

function findPythonScript(): string | null {
  const fromCwd = join(process.cwd(), 'scripts', 'structural-indexer.py');
  if (existsSync(fromCwd)) return fromCwd;

  const here = dirname(fileURLToPath(import.meta.url));
  const fromCompiled = join(here, '..', '..', 'scripts', 'structural-indexer.py');
  if (existsSync(fromCompiled)) return fromCompiled;

  const fromSource = join(here, '..', '..', '..', 'scripts', 'structural-indexer.py');
  if (existsSync(fromSource)) return fromSource;
  return null;
}

interface PythonExtractorResponse {
  symbols: CodeSymbol[];
  references: CodeReference[];
}

function runPythonStructuralExtractor(
  python: string,
  script: string,
  text: string,
  language: string,
  filePath: string | undefined,
  timeoutMs: number
): Promise<PythonExtractorResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    const id = randomUUID();
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('structural extractor timed out'));
    }, timeoutMs);

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr || `structural extractor exited ${code}`));
        return;
      }
      try {
        const response = JSON.parse(stdout) as {
          id?: string;
          result?: PythonExtractorResponse;
          error?: { message?: string };
        };
        if (response.id !== id || !response.result) {
          reject(new Error(response.error?.message ?? 'invalid structural extractor response'));
          return;
        }
        resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.end(JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'extract',
      params: { text, language, path: filePath },
    }));
  });
}

function normalizeSymbol(symbol: CodeSymbol, filePath: string | undefined, language: string): CodeSymbol {
  return {
    ...symbol,
    id: symbol.id ?? randomUUID(),
    path: symbol.path ?? filePath,
    language: symbol.language ?? language,
    normalizedName: symbol.normalizedName || normalizeSymbolName(symbol.name),
    startLine: symbol.startLine || 1,
    endLine: symbol.endLine || symbol.startLine || 1,
    isExported: Boolean(symbol.isExported),
    metadata: symbol.metadata ?? {},
  };
}

function normalizeReference(reference: CodeReference, filePath: string | undefined, language: string): CodeReference {
  return {
    ...reference,
    id: reference.id ?? randomUUID(),
    path: reference.path ?? filePath,
    language: reference.language ?? language,
    normalizedTarget: reference.normalizedTarget || normalizeIdentifier(reference.target),
    startLine: reference.startLine || 1,
    endLine: reference.endLine || reference.startLine || 1,
    metadata: reference.metadata ?? {},
  };
}
