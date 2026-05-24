import type { ContextChunk, SymbolInfo } from '../types/index.js';
import { extractStructureFallback } from './structural-indexer.js';

const SYMBOL_INFO_KINDS = new Set<SymbolInfo['kind']>([
  'function',
  'class',
  'interface',
  'type',
  'variable',
  'method',
]);

export function extractSymbols(
  text: string,
  language?: string,
  filePath?: string
): SymbolInfo[] {
  return extractStructureFallback(text, language, filePath)
    .symbols
    .filter((symbol): symbol is typeof symbol & { kind: SymbolInfo['kind'] } =>
      SYMBOL_INFO_KINDS.has(symbol.kind as SymbolInfo['kind'])
    )
    .map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      line: symbol.startLine,
      filePath,
    }));
}

export function buildSymbolIndex(chunks: ContextChunk[]): Map<string, SymbolInfo[]> {
  const index = new Map<string, SymbolInfo[]>();

  for (const chunk of chunks) {
    if (chunk.type !== 'code') continue;
    index.set(chunk.id, extractSymbols(chunk.text, chunk.language, chunk.path));
  }

  return index;
}
