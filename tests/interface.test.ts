import { describe, expect, it } from 'vitest';
import { buildCLI } from '../src/cli/index.js';
import { TOOL_DEFINITIONS } from '../src/mcp/server.js';

describe('CLI interface', () => {
  it('exposes project ingestion and retrieval selection options', () => {
    const cli = buildCLI();
    const ingestProject = cli.commands.find((command) => command.name() === 'ingest-project');
    const retrieve = cli.commands.find((command) => command.name() === 'retrieve');

    expect(ingestProject).toBeDefined();
    expect(ingestProject?.options.map((option) => option.long)).toContain('--include-tests');
    expect(ingestProject?.options.map((option) => option.long)).toContain('--include-benchmarks');
    expect(ingestProject?.options.map((option) => option.long)).toContain('--no-docs');
    expect(retrieve?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--mode', '--return-limit', '--top-k'])
    );
  });
});

describe('MCP interface', () => {
  it('exposes ingest_project and focused retrieval controls', () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);
    const retrieve = TOOL_DEFINITIONS.find((tool) => tool.name === 'retrieve_context');
    const ingestProject = TOOL_DEFINITIONS.find((tool) => tool.name === 'ingest_project');

    expect(names).toContain('ingest_project');
    expect(retrieve?.inputSchema.properties).toHaveProperty('mode');
    expect(retrieve?.inputSchema.properties).toHaveProperty('returnLimit');
    expect(ingestProject?.inputSchema.properties).toHaveProperty('includeTests');
    expect(ingestProject?.inputSchema.properties).toHaveProperty('includeBenchmarks');
  });
});
