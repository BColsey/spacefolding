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
  'def',
  'elif',
  'except',
  'finally',
  'with',
  'lambda',
  'await',
  'yield',
]);

const IGNORED_CALL_TARGETS = new Set([
  ...CONTROL_WORDS,
  'console',
  'log',
  'debug',
  'info',
  'warn',
  'error',
  'require',
  'import',
  'super',
]);

type AddSymbol = (
  name: string,
  kind: CodeSymbolKind,
  index: number,
  signature: string,
  isExported: boolean,
  metadata?: Record<string, unknown>
) => void;

type AddReference = (
  target: string,
  kind: CodeReferenceKind,
  index: number,
  metadata?: Record<string, unknown>
) => void;

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
      const fallback = extractStructureFallback(text, language, filePath);
      const symbols = mergeSymbols(
        result.symbols.map((symbol) => normalizeSymbol(symbol, filePath, language)),
        fallback.symbols
      );
      const references = filterLocalCallReferences(
        mergeReferences(
          result.references.map((reference) => normalizeReference(reference, filePath, language)),
          fallback.references
        ),
        symbols
      );
      return {
        symbols,
        references,
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
  const pythonClassIndents: number[] = [];

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
        prunePythonClassStack(pythonClassIndents, line);
        extractPythonLine(trimmed, line, i, pythonClassIndents.length > 0, addSymbol, addReference);
        if (/^class\s+[A-Za-z_][\w]*\b/.test(trimmed)) {
          pythonClassIndents.push(leadingSpaces(line));
        }
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
    references: filterLocalCallReferences(references, symbols)
      .sort((a, b) => a.startLine - b.startLine || a.target.localeCompare(b.target)),
  };
}

function extractJsLine(
  line: string,
  index: number,
  addSymbol: AddSymbol,
  addReference: AddReference
): void {
  const excludedCalls = new Set<string>();

  for (const pattern of [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s+['"]([^'"]+)['"]/g,
  ]) {
    for (const match of line.matchAll(pattern)) addReference(match[1], 'import', index);
  }

  extractJsExportReferences(line, index, addReference);
  extractJsInheritanceReferences(line, index, addReference);

  const isExported = /\bexport\b/.test(line);
  const functionMatch = line.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (functionMatch) {
    addSymbol(functionMatch[1], 'function', index, line, isExported);
    excludedCalls.add(functionMatch[1]);
    if (isExported) addReference(functionMatch[1], 'export', index);
  } else if (line.match(/^(?:module\.)?exports(?:\.[A-Za-z_$][\w$]*)?\s*=\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/)) {
    const moduleFunctionMatch = line.match(/^(?:module\.)?exports(?:\.[A-Za-z_$][\w$]*)?\s*=\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (moduleFunctionMatch) {
      addSymbol(moduleFunctionMatch[1], 'function', index, line, true);
      addReference(moduleFunctionMatch[1], 'export', index);
      excludedCalls.add(moduleFunctionMatch[1]);
    }
  } else if (line.match(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/)) {
    const commonJsExportMatch = line.match(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/);
    if (commonJsExportMatch) {
      addReference(commonJsExportMatch[1], 'export', index);
    }
  } else if (line.match(/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)\b/)) {
    const classMatch = line.match(/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)\b/);
    if (!classMatch) return;
    addSymbol(classMatch[1], 'class', index, line, isExported);
    excludedCalls.add(classMatch[1]);
    if (isExported) addReference(classMatch[1], 'export', index);
  } else if (line.match(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/)) {
    const interfaceMatch = line.match(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/);
    if (!interfaceMatch) return;
    addSymbol(interfaceMatch[1], 'interface', index, line, isExported);
    excludedCalls.add(interfaceMatch[1]);
    if (isExported) addReference(interfaceMatch[1], 'export', index);
  } else if (line.match(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/)) {
    const typeMatch = line.match(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/);
    if (!typeMatch) return;
    addSymbol(typeMatch[1], 'type', index, line, isExported);
    excludedCalls.add(typeMatch[1]);
    if (isExported) addReference(typeMatch[1], 'export', index);
  } else if (line.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/)) {
    const variableMatch = line.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/);
    if (!variableMatch) return;
    const kind: CodeSymbolKind = /=>|\bfunction\b/.test(line) ? 'function' : 'variable';
    addSymbol(variableMatch[1], kind, index, line, isExported);
    excludedCalls.add(variableMatch[1]);
    if (isExported) addReference(variableMatch[1], 'export', index);
  } else {
    const methodMatch = line.match(/^(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::\s*[^={]+)?\s*\{/);
    if (methodMatch && !CONTROL_WORDS.has(methodMatch[1])) {
      addSymbol(methodMatch[1], 'method', index, line, false);
      excludedCalls.add(methodMatch[1]);
    }
  }

  extractJsEmbeddedMethodSymbols(line, index, addSymbol, excludedCalls);
  extractCallReferences(line, index, 'javascript', addReference, excludedCalls);
}

function extractPythonLine(
  line: string,
  rawLine: string,
  index: number,
  insideClass: boolean,
  addSymbol: AddSymbol,
  addReference: AddReference
): void {
  const excludedCalls = new Set<string>();

  const fromMatch = line.match(/^from\s+([A-Za-z_][\w.]*|\.+[A-Za-z_][\w.]*)\s+import\s+(.+)/);
  if (fromMatch) addReference(fromMatch[1], 'import', index, { imported: fromMatch[2] });

  const importMatch = line.match(/^import\s+(.+)/);
  if (importMatch) {
    for (const target of importMatch[1].split(',')) {
      addReference(target.replace(/\s+as\s+\w+$/, ''), 'import', index);
    }
  }

  for (const exportMatch of line.matchAll(/__all__\s*=\s*\[([^\]]*)\]/g)) {
    for (const nameMatch of exportMatch[1].matchAll(/['"]([A-Za-z_][\w]*)['"]/g)) {
      addReference(nameMatch[1], 'export', index);
    }
  }

  const functionMatch = line.match(/^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/);
  if (functionMatch) {
    addSymbol(functionMatch[1], insideClass ? 'method' : 'function', index, line, !functionMatch[1].startsWith('_'));
    excludedCalls.add(functionMatch[1]);
  } else if (line.match(/^class\s+([A-Za-z_][\w]*)\b/)) {
    const classMatch = line.match(/^class\s+([A-Za-z_][\w]*)\b/);
    if (!classMatch) return;
    addSymbol(classMatch[1], 'class', index, line, !classMatch[1].startsWith('_'));
    excludedCalls.add(classMatch[1]);
    const bases = line.match(/^class\s+[A-Za-z_][\w]*\s*\(([^)]*)\)/);
    if (bases) addReferenceList(bases[1], 'inheritance', index, addReference);
  }

  extractCallReferences(rawLine, index, 'python', addReference, excludedCalls);
}

function extractRustLine(
  line: string,
  index: number,
  addSymbol: AddSymbol,
  addReference: AddReference
): void {
  const excludedCalls = new Set<string>();
  const useMatch = line.match(/^(?:pub\s+)?use\s+(.+?);?$/);
  if (useMatch) {
    addReference(useMatch[1], 'import', index);
    if (line.startsWith('pub ')) addReference(useMatch[1], 'export', index);
  }

  const modMatch = line.match(/^(?:pub\s+)?mod\s+([A-Za-z_][\w]*)\s*;?/);
  if (modMatch) {
    addSymbol(modMatch[1], 'module', index, line, line.startsWith('pub '));
    addReference(modMatch[1], 'module', index);
    if (line.startsWith('pub ')) addReference(modMatch[1], 'export', index);
    excludedCalls.add(modMatch[1]);
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
    excludedCalls.add(symbolMatch[2]);
    if (line.startsWith('pub')) addReference(symbolMatch[2], 'export', index);
  }

  extractCallReferences(line, index, 'rust', addReference, excludedCalls);
}

function extractGoLine(
  line: string,
  index: number,
  addSymbol: AddSymbol,
  addReference: AddReference
): void {
  const excludedCalls = new Set<string>();
  const importMatch = line.match(/^import\s+(?:\w+\s+)?["`]([^"`]+)["`]/);
  if (importMatch) addReference(importMatch[1], 'import', index);
  const blockImportMatch = line.match(/^(?:\w+\s+)?["`]([^"`]+)["`]$/);
  if (blockImportMatch) addReference(blockImportMatch[1], 'import', index);

  const methodMatch = line.match(/^func\s+\([^)]*\)\s+([A-Za-z_][\w]*)\s*\(/);
  if (methodMatch) {
    addSymbol(methodMatch[1], 'method', index, line, /^[A-Z]/.test(methodMatch[1]));
    excludedCalls.add(methodMatch[1]);
    if (/^[A-Z]/.test(methodMatch[1])) addReference(methodMatch[1], 'export', index);
  } else if (line.match(/^func\s+([A-Za-z_][\w]*)\s*\(/)) {
    const functionMatch = line.match(/^func\s+([A-Za-z_][\w]*)\s*\(/);
    if (!functionMatch) return;
    addSymbol(functionMatch[1], 'function', index, line, /^[A-Z]/.test(functionMatch[1]));
    excludedCalls.add(functionMatch[1]);
    if (/^[A-Z]/.test(functionMatch[1])) addReference(functionMatch[1], 'export', index);
  } else if (line.match(/^type\s+([A-Za-z_][\w]*)\s+(struct|interface)\b/)) {
    const typeMatch = line.match(/^type\s+([A-Za-z_][\w]*)\s+(struct|interface)\b/);
    if (!typeMatch) return;
    addSymbol(typeMatch[1], typeMatch[2] === 'interface' ? 'interface' : 'struct', index, line, /^[A-Z]/.test(typeMatch[1]));
    excludedCalls.add(typeMatch[1]);
    if (/^[A-Z]/.test(typeMatch[1])) addReference(typeMatch[1], 'export', index);
  } else if (line.match(/^(?:var|const)\s+([A-Za-z_][\w]*)\b/)) {
    const variableMatch = line.match(/^(?:var|const)\s+([A-Za-z_][\w]*)\b/);
    if (!variableMatch) return;
    addSymbol(variableMatch[1], line.startsWith('const') ? 'constant' : 'variable', index, line, /^[A-Z]/.test(variableMatch[1]));
    excludedCalls.add(variableMatch[1]);
    if (/^[A-Z]/.test(variableMatch[1])) addReference(variableMatch[1], 'export', index);
  }

  extractCallReferences(line, index, 'go', addReference, excludedCalls);
}

function extractJavaLine(
  line: string,
  index: number,
  addSymbol: AddSymbol,
  addReference: AddReference
): void {
  const excludedCalls = new Set<string>();
  const importMatch = line.match(/^import\s+(?:static\s+)?([A-Za-z_][\w.]*\*?)\s*;/);
  if (importMatch) addReference(importMatch[1], 'import', index);

  extractJavaInheritanceReferences(line, index, addReference);

  const classMatch = line.match(/^(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+)*((?:class)|(?:interface)|(?:enum))\s+([A-Za-z_][\w]*)\b/);
  if (classMatch) {
    const kind = classMatch[1] === 'class' ? 'class' : classMatch[1] === 'interface' ? 'interface' : 'enum';
    addSymbol(classMatch[2], kind, index, line, line.startsWith('public '));
    excludedCalls.add(classMatch[2]);
    if (line.startsWith('public ')) addReference(classMatch[2], 'export', index);
  } else {
    const methodMatch = line.match(/^(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|synchronized\s+)*[A-Za-z_<>\[\], ?]+\s+([A-Za-z_][\w]*)\s*\([^;]*\)\s*(?:throws\s+[^{]+)?\{/);
    if (methodMatch && !CONTROL_WORDS.has(methodMatch[1])) {
      addSymbol(methodMatch[1], 'method', index, line, line.startsWith('public '));
      excludedCalls.add(methodMatch[1]);
      if (line.startsWith('public ')) addReference(methodMatch[1], 'export', index);
    }
  }

  extractCallReferences(line, index, 'java', addReference, excludedCalls);
}

function extractJsExportReferences(line: string, index: number, addReference: AddReference): void {
  const moduleExport = line.match(/^export\s+(?:type\s+)?\{([^}]+)\}(?:\s+from\s+['"]([^'"]+)['"])?/);
  if (moduleExport) {
    for (const name of splitExportList(moduleExport[1])) {
      addReference(name, 'export', index);
    }
    if (moduleExport[2]) addReference(moduleExport[2], 'export', index, { exports: splitExportList(moduleExport[1]) });
  }

  const starExport = line.match(/^export\s+\*\s+from\s+['"]([^'"]+)['"]/);
  if (starExport) addReference(starExport[1], 'export', index, { all: true });

  const defaultExport = line.match(/^export\s+default\s+([A-Za-z_$][\w$]*)\b/);
  if (defaultExport && !CONTROL_WORDS.has(defaultExport[1])) {
    addReference(defaultExport[1], 'export', index, { default: true });
  }
}

function extractJsInheritanceReferences(line: string, index: number, addReference: AddReference): void {
  const extendsMatch = line.match(/\bextends\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/);
  if (extendsMatch) addReference(extendsMatch[1], 'inheritance', index);

  const implementsMatch = line.match(/\bimplements\s+([^{]+)/);
  if (implementsMatch) addReferenceList(implementsMatch[1], 'inheritance', index, addReference);
}

function extractJsEmbeddedMethodSymbols(
  line: string,
  index: number,
  addSymbol: AddSymbol,
  excludedCalls: Set<string>
): void {
  const methodPattern = /\b([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?::\s*[^={]+)?\s*\{/g;
  for (const match of line.matchAll(methodPattern)) {
    const name = match[1];
    const prefix = line.slice(Math.max(0, match.index - 24), match.index);
    if (CONTROL_WORDS.has(name) || /\b(?:function|if|for|while|switch|catch)\s+$/.test(prefix)) continue;
    addSymbol(name, 'method', index, line, false);
    excludedCalls.add(name);
  }
}

function extractJavaInheritanceReferences(line: string, index: number, addReference: AddReference): void {
  const extendsMatch = line.match(/\bextends\s+([A-Za-z_][\w.]*)/);
  if (extendsMatch) addReference(extendsMatch[1], 'inheritance', index);

  const implementsMatch = line.match(/\bimplements\s+([^{]+)/);
  if (implementsMatch) addReferenceList(implementsMatch[1], 'inheritance', index, addReference);
}

function extractCallReferences(
  line: string,
  index: number,
  language: string,
  addReference: AddReference,
  excludedNames: Set<string> = new Set()
): void {
  const code = stripComments(stripStringLiterals(line), language);
  const callPattern = /\b([A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*)\s*\(/g;
  for (const match of code.matchAll(callPattern)) {
    const target = match[1];
    const root = target.split(/\.|::/)[0];
    const leaf = target.split(/\.|::/).pop() ?? target;
    const lowerRoot = root.toLowerCase();
    const lowerLeaf = leaf.toLowerCase();
    const prefix = code.slice(Math.max(0, match.index - 18), match.index);
    if (/\b(?:function|def|fn|func|class|interface|type)\s+$/.test(prefix)) continue;
    if (excludedNames.has(target) || excludedNames.has(leaf)) continue;
    if (IGNORED_CALL_TARGETS.has(lowerRoot) || IGNORED_CALL_TARGETS.has(lowerLeaf)) continue;
    if (target.startsWith('this.') || target.startsWith('self.')) {
      addReference(leaf, 'call', index, { receiver: target.split(/\.|::/)[0] });
      continue;
    }
    addReference(target, 'call', index);
  }
}

function filterLocalCallReferences(references: CodeReference[], symbols: CodeSymbol[]): CodeReference[] {
  const localSymbolNames = new Set(symbols.map((symbol) => symbol.normalizedName));
  return references.filter((reference) =>
    reference.kind !== 'call' || !localSymbolNames.has(normalizeSymbolName(referenceLeafName(reference.target)))
  );
}

function referenceLeafName(target: string): string {
  return target.split(/\.|::/).pop() ?? target;
}

function addReferenceList(
  value: string,
  kind: CodeReferenceKind,
  index: number,
  addReference: AddReference
): void {
  for (const part of value.split(',')) {
    const target = part
      .replace(/\bas\b\s+[A-Za-z_$][\w$]*/g, '')
      .replace(/\bextends\b|\bimplements\b/g, '')
      .replace(/[<>{}()[\];]/g, ' ')
      .trim()
      .split(/\s+/)[0];
    if (target) addReference(target, kind, index);
  }
}

function splitExportList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
}

function stripStringLiterals(value: string): string {
  return value
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

function stripComments(value: string, language: string): string {
  if (language === 'python') return value.replace(/#.*/, '');
  return value.replace(/\/\/.*/, '');
}

function prunePythonClassStack(classIndents: number[], line: string): void {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  const indent = leadingSpaces(line);
  while (classIndents.length > 0 && indent <= classIndents[classIndents.length - 1]) {
    classIndents.pop();
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

function mergeSymbols(primary: CodeSymbol[], fallback: CodeSymbol[]): CodeSymbol[] {
  const merged: CodeSymbol[] = [];
  const positions = new Map<string, number>();
  for (const symbol of [...primary, ...fallback]) {
    const key = `${symbol.normalizedName || normalizeSymbolName(symbol.name)}:${symbol.startLine}`;
    const existingIndex = positions.get(key);
    if (existingIndex !== undefined) {
      const existing = merged[existingIndex];
      if (shouldReplaceMergedSymbol(existing, symbol)) {
        merged[existingIndex] = symbol;
      }
      continue;
    }
    positions.set(key, merged.length);
    merged.push(symbol);
  }
  return merged.sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name));
}

function shouldReplaceMergedSymbol(existing: CodeSymbol, candidate: CodeSymbol): boolean {
  if (existing.kind === 'function' && candidate.kind === 'method') return true;
  if (!existing.isExported && candidate.isExported) return true;
  return false;
}

function mergeReferences(primary: CodeReference[], fallback: CodeReference[]): CodeReference[] {
  const merged: CodeReference[] = [];
  const seen = new Set<string>();
  for (const reference of [...primary, ...fallback]) {
    const key = `${reference.kind}:${reference.normalizedTarget || normalizeIdentifier(reference.target)}:${reference.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(reference);
  }
  return merged.sort((a, b) => a.startLine - b.startLine || a.target.localeCompare(b.target));
}
