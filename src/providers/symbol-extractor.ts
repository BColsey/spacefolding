import type { SymbolInfo } from '../types/index.js';
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
