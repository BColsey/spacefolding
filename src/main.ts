#!/usr/bin/env node

import { buildCLI } from './cli/index.js';

const program = buildCLI();

// If no subcommand given, default to 'serve'
const args = process.argv.slice(2);
const knownCommands = ['serve', 'ingest', 'score', 'explain', 'graph', 'watch', 'export', 'import', 'symbols', 'health', 'download-model', 'retrieve', 'help'];
const hasCommand = args.some((a) => knownCommands.includes(a) || a === '--help' || a === '-h' || a === '-V' || a === '--version');

if (args.length === 0) {
  args.unshift('serve');
} else if (!hasCommand && !args[0].startsWith('-')) {
  args.unshift('serve');
}

program.parse(args, { from: 'user' });
