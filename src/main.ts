#!/usr/bin/env node

import { buildCLI } from './cli/index.js';

const program = buildCLI();

// If no subcommand given, default to 'serve'
const args = process.argv.slice(2);
const knownCommands = ['serve', 'ingest', 'score', 'explain', 'graph', 'health', 'help'];
const hasCommand = args.some((a) => knownCommands.includes(a));

if (!hasCommand) {
  args.unshift('serve');
}

program.parse(args, { from: 'user' });
