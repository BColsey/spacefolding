/**
 * Ambient declarations for OPTIONAL dependencies that are not installed by default.
 *
 * `web-tree-sitter` powers the opt-in pure-JS AST chunker
 * (src/core/web-tree-sitter-chunker.ts), which is OFF by default (the benchmarked
 * config uses maxTokens=2000 with AST off — see benchmarks/CHUNK-SIZE-FINDINGS.md).
 * The chunker guards the package's absence at runtime (it dynamically imports the
 * module and returns null if it or a grammar is missing). This declaration keeps
 * `tsc`/`npm run build` clean when the package isn't installed; install
 * `web-tree-sitter` to actually enable AST chunking.
 */
declare module 'web-tree-sitter';
