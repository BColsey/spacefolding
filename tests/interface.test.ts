import { describe, expect, it } from 'vitest';
import { buildCLI } from '../src/cli/index.js';
import { TOOL_DEFINITIONS, validateArgs } from '../src/mcp/server.js';

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

  it('retrieve command has mode, strategy, max-tokens, and top-k options', () => {
    const cli = buildCLI();
    const retrieve = cli.commands.find((command) => command.name() === 'retrieve');
    const optionLongs = retrieve?.options.map((option) => option.long) ?? [];

    expect(optionLongs).toContain('--mode');
    expect(optionLongs).toContain('--strategy');
    expect(optionLongs).toContain('--max-tokens');
    expect(optionLongs).toContain('--top-k');
    expect(optionLongs).toContain('--return-limit');
    expect(optionLongs).toContain('--max-hops');
  });

  it('retrieve command mode option describes focused, broad, exhaustive', () => {
    const cli = buildCLI();
    const retrieve = cli.commands.find((command) => command.name() === 'retrieve');
    const modeOpt = retrieve?.options.find((option) => option.long === '--mode');

    expect(modeOpt?.description).toContain('focused');
    expect(modeOpt?.description).toContain('broad');
    expect(modeOpt?.description).toContain('exhaustive');
  });

  it('retrieve command defaults to focused mode', () => {
    const cli = buildCLI();
    const retrieve = cli.commands.find((command) => command.name() === 'retrieve');
    const modeOpt = retrieve?.options.find((option) => option.long === '--mode');

    expect(modeOpt?.defaultValue).toBe('focused');
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

  it('retrieve_context mode enum accepts focused, broad, and exhaustive', () => {
    const retrieve = TOOL_DEFINITIONS.find((tool) => tool.name === 'retrieve_context');
    const modeProp = retrieve?.inputSchema.properties.mode as { enum?: string[] };
    expect(modeProp?.enum).toEqual(['focused', 'broad', 'exhaustive']);
  });

  it('retrieve_context strategy enum accepts all retrieval strategies', () => {
    const retrieve = TOOL_DEFINITIONS.find((tool) => tool.name === 'retrieve_context');
    const strategyProp = retrieve?.inputSchema.properties.strategy as { enum?: string[] };
    expect(strategyProp?.enum).toEqual(['structural', 'hybrid', 'vector', 'text', 'graph']);
  });

  it('retrieve_context schema describes mode, strategy, budget, and query options', () => {
    const retrieve = TOOL_DEFINITIONS.find((tool) => tool.name === 'retrieve_context');
    const props = retrieve?.inputSchema.properties as Record<string, { description?: string }>;

    expect(props.query?.description).toBeTruthy();
    expect(props.mode?.description).toBeTruthy();
    expect(props.strategy?.description).toBeTruthy();
    expect(props.maxTokens?.description).toBeTruthy();
    expect(props.topK?.description).toBeTruthy();
    expect(props.returnLimit?.description).toBeTruthy();
  });
});

describe('MCP input validation', () => {
  it('rejects invalid strategy with useful message', () => {
    const error = validateArgs({ strategy: 'invalid_strategy' });
    expect(error).toBeTruthy();
    expect(error).toContain('strategy must be one of');
    expect(error).toContain('structural');
    expect(error).toContain('hybrid');
  });

  it('rejects invalid mode with useful message', () => {
    const error = validateArgs({ mode: 'ultra' });
    expect(error).toBeTruthy();
    expect(error).toContain('mode must be one of');
    expect(error).toContain('focused');
    expect(error).toContain('broad');
    expect(error).toContain('exhaustive');
  });

  it('accepts valid mode and strategy', () => {
    expect(validateArgs({ mode: 'focused', strategy: 'structural' })).toBeUndefined();
    expect(validateArgs({ mode: 'broad', strategy: 'hybrid' })).toBeUndefined();
    expect(validateArgs({ mode: 'exhaustive', strategy: 'vector' })).toBeUndefined();
  });

  it('accepts request without mode or strategy', () => {
    expect(validateArgs({ query: 'test' })).toBeUndefined();
  });
});
