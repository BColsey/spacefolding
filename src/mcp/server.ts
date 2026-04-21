import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';

const TOOL_DEFINITIONS = [
  {
    name: 'score_context',
    description:
      'Score and route context chunks into hot/warm/cold tiers for a given task',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task: {
          type: 'object' as const,
          properties: {
            text: { type: 'string', description: 'The task description' },
            type: { type: 'string', description: 'Optional task type' },
            priority: { type: 'string', description: 'Optional priority' },
          },
          required: ['text'],
        },
        chunkIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional subset of chunk IDs to score',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'compress_context',
    description: 'Compress warm-context chunks into a structured summary',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task: {
          type: 'object' as const,
          properties: {
            text: { type: 'string' },
            type: { type: 'string' },
            priority: { type: 'string' },
          },
          required: ['text'],
        },
        chunkIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Chunk IDs to compress',
        },
      },
      required: ['task', 'chunkIds'],
    },
  },
  {
    name: 'get_relevant_memory',
    description:
      'Retrieve context chunks from warm/cold storage that are relevant to a task',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task: {
          type: 'object' as const,
          properties: {
            text: { type: 'string' },
            type: { type: 'string' },
            priority: { type: 'string' },
          },
          required: ['text'],
        },
        filters: {
          type: 'object' as const,
          properties: {
            source: { type: 'string' },
            type: { type: 'string' },
            tier: { type: 'string' },
            path: { type: 'string' },
            textContains: { type: 'string' },
          },
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'ingest_context',
    description: 'Ingest a new context item (text, code, diff, log, etc.)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source: { type: 'string', description: 'Where this context came from' },
        text: { type: 'string', description: 'The context text' },
        type: {
          type: 'string',
          description:
            'Chunk type: fact, constraint, instruction, code, log, background, summary, diff, reference',
        },
        path: { type: 'string', description: 'File path if from a file' },
        language: { type: 'string', description: 'Programming language if code' },
      },
      required: ['source', 'text'],
    },
  },
  {
    name: 'update_context_graph',
    description: 'Add or remove dependency links in the context graph',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chunkId: { type: 'string', description: 'The primary chunk ID' },
        operation: {
          type: 'string',
          enum: ['add', 'remove'],
          description: 'Whether to add or remove links',
        },
        dependencies: {
          type: 'array',
          items: {
            type: 'object' as const,
            properties: {
              fromId: { type: 'string' },
              toId: { type: 'string' },
              type: {
                type: 'string',
                enum: ['references', 'defines', 'summarizes', 'overrides', 'contains'],
              },
              weight: { type: 'number' },
            },
            required: ['fromId', 'toId', 'type'],
          },
        },
      },
      required: ['chunkId', 'operation', 'dependencies'],
    },
  },
  {
    name: 'explain_routing',
    description:
      'Explain why context chunks were routed to hot/warm/cold for a given task',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task: {
          type: 'object' as const,
          properties: {
            text: { type: 'string' },
            type: { type: 'string' },
            priority: { type: 'string' },
          },
          required: ['text'],
        },
        chunkId: {
          type: 'string',
          description: 'Optional specific chunk to explain',
        },
      },
      required: ['task'],
    },
  },
];

export function startMCPServer(
  pipeline: PipelineOrchestrator,
  _options?: { port?: number; transport?: 'stdio' | 'sse' }
): Server {
  const server = new Server(
    { name: 'spacefolding', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'score_context': {
          const result = await pipeline.processContext(args!.task as { text: string; type?: string; priority?: string });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'compress_context': {
          const chunkIds = (args!.chunkIds as string[]) ?? [];
          // Get chunks, compress
          const allChunks = pipeline['storage'].getAllChunks().filter((c: { id: string }) => chunkIds.includes(c.id));
          const compression = await pipeline['compressionProvider'].compress(
            args!.task as { text: string; type?: string; priority?: string },
            allChunks
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(compression, null, 2) }],
          };
        }

        case 'get_relevant_memory': {
          const filters = args!.filters as Record<string, string> | undefined;
          const typedFilters: import('../types/index.js').ContextFilter | undefined = filters
            ? { ...filters, type: filters.type as import('../types/index.js').ChunkType | undefined }
            : undefined;
          const result = await pipeline.getRelevantMemory(
            args!.task as { text: string; type?: string; priority?: string },
            typedFilters
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'ingest_context': {
          const chunk = pipeline.ingest(
            args!.source as string,
            args!.text as string,
            args!.type as string | undefined,
            args!.path as string | undefined,
            args!.language as string | undefined
          );
          return {
            content: [{ type: 'text', text: JSON.stringify({ chunkId: chunk.id }, null, 2) }],
          };
        }

        case 'update_context_graph': {
          const deps = (args!.dependencies as Array<{
            fromId: string;
            toId: string;
            type: string;
            weight?: number;
          }>) ?? [];
          const links = deps.map((d) => ({
            fromId: d.fromId,
            toId: d.toId,
            type: d.type as 'references' | 'defines' | 'summarizes' | 'overrides' | 'contains',
            weight: d.weight ?? 0.5,
          }));
          if ((args!.operation as string) === 'add') {
            pipeline.addDependencies(links);
          } else {
            pipeline.removeDependencies(links);
          }
          const stored = pipeline.getDependencies(args!.chunkId as string);
          return {
            content: [{ type: 'text', text: JSON.stringify({ links: stored }, null, 2) }],
          };
        }

        case 'explain_routing': {
          const result = await pipeline.explainRouting(
            args!.task as { text: string; type?: string; priority?: string },
            args!.chunkId as string | undefined
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        default:
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
            isError: true,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  // Connect with stdio transport
  const transport = new StdioServerTransport();
  server.connect(transport);

  return server;
}
