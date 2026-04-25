import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';

const USE_GPU = process.env.USE_GPU === '1';
const MAX_TASK_TEXT_LENGTH = 10_000;
const MAX_TEXT_LENGTH = 100_000;
const MAX_CHUNK_IDS = 1_000;

function describeTool(description: string): string {
  return USE_GPU
    ? `${description} GPU acceleration is enabled when the runtime supports it.`
    : description;
}

const TOOL_DEFINITIONS = [
  {
    name: 'score_context',
    description: describeTool(
      'Score and route context chunks into hot/warm/cold tiers for a given task'
    ),
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
        maxTokens: {
          type: 'number',
          description: 'Max token budget for hot tier',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'compress_context',
    description: describeTool('Compress warm-context chunks into a structured summary'),
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
    description: describeTool(
      'Retrieve context chunks from warm/cold storage that are relevant to a task'
    ),
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
    description: describeTool('Ingest a new context item (text, code, diff, log, etc.)'),
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
    description: describeTool('Add or remove dependency links in the context graph'),
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
    description: describeTool(
      'Explain why context chunks were routed to hot/warm/cold for a given task'
    ),
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
  {
    name: 'retrieve_context',
    description: describeTool(
      'Retrieve relevant context using hybrid search (vector + full-text + dependency graph) with automatic budget control'
    ),
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query describing what context you need',
        },
        maxTokens: {
          type: 'number',
          description: 'Maximum token budget for results (default: auto based on query intent)',
        },
        strategy: {
          type: 'string',
          enum: ['hybrid', 'vector', 'text', 'graph'],
          description: 'Retrieval strategy (default: hybrid)',
        },
        topK: {
          type: 'number',
          description: 'Max results to return (default: 50)',
        },
        maxHops: {
          type: 'number',
          description: 'Max dependency graph traversal hops (default: auto)',
        },
      },
      required: ['query'],
    },
  },
];

function createServer(pipeline: PipelineOrchestrator): Server {
  const server = new Server(
    { name: 'spacefolding', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const validationError = validateArgs(args as Record<string, unknown> | undefined);
    if (validationError) {
      return errorResponse(validationError);
    }

    try {
      switch (name) {
        case 'score_context': {
          const chunkIds = (args!.chunkIds as string[] | undefined)?.slice(0, MAX_CHUNK_IDS);
          const allowedChunkIds = chunkIds ? new Set(chunkIds) : undefined;
          const result = await pipeline.processContext({
            ...(args!.task as { text: string; type?: string; priority?: string }),
            maxTokens: args!.maxTokens as number | undefined,
          } as { text: string; type?: string; priority?: string; maxTokens?: number });
          if (!allowedChunkIds) {
            return jsonResponse(result);
          }
          return jsonResponse({
            ...result,
            hot: result.hot.filter((id) => allowedChunkIds.has(id)),
            warm: result.warm.filter((id) => allowedChunkIds.has(id)),
            cold: result.cold.filter((id) => allowedChunkIds.has(id)),
          });
        }

        case 'compress_context': {
          const chunkIds = ((args!.chunkIds as string[]) ?? []).slice(0, MAX_CHUNK_IDS);
          const chunkIdSet = new Set(chunkIds);
          const compression = await pipeline.compressChunks(
            args!.task as { text: string; type?: string; priority?: string },
            pipeline.getAllChunks().filter((chunk) => chunkIdSet.has(chunk.id))
          );
          return jsonResponse(compression);
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
          return jsonResponse(result);
        }

        case 'ingest_context': {
          const chunk = pipeline.ingest(
            args!.source as string,
            args!.text as string,
            args!.type as string | undefined,
            args!.path as string | undefined,
            args!.language as string | undefined
          );
          return jsonResponse({ chunkId: chunk.id });
        }

        case 'update_context_graph': {
          const deps = (args!.dependencies as Array<{
            fromId: string;
            toId: string;
            type: string;
            weight?: number;
          }>) ?? [];
          const links = deps.map((dependency) => ({
            fromId: dependency.fromId,
            toId: dependency.toId,
            type: dependency.type as 'references' | 'defines' | 'summarizes' | 'overrides' | 'contains',
            weight: dependency.weight ?? 0.5,
          }));
          if ((args!.operation as string) === 'add') {
            pipeline.addDependencies(links);
          } else {
            pipeline.removeDependencies(links);
          }
          return jsonResponse({ links: pipeline.getDependencies(args!.chunkId as string) });
        }

        case 'explain_routing': {
          const result = await pipeline.explainRouting(
            args!.task as { text: string; type?: string; priority?: string },
            args!.chunkId as string | undefined
          );
          return jsonResponse(result);
        }

        case 'retrieve_context': {
          const query = args!.query as string;
          const maxTokens = args!.maxTokens as number | undefined;
          const strategy = (args!.strategy as 'hybrid' | 'vector' | 'text' | 'graph' | undefined) ?? 'hybrid';
          const topK = (args!.topK as number | undefined) ?? 50;
          const maxHops = args!.maxHops as number | undefined;

          const result = await pipeline.retrieve(query, maxTokens, { strategy, topK, maxHops });
          return jsonResponse({
            chunks: result.chunks.map((c) => ({
              id: c.id,
              type: c.type,
              text: c.text,
              path: c.path,
              tokensEstimate: c.tokensEstimate,
              tier: result.tiers.get(c.id) ?? 'warm',
              retrievalSources: result.retrieval.find((r) => r.chunkId === c.id)?.sources ?? [],
            })),
            totalTokens: result.totalTokens,
            budget: result.budget,
            utilization: result.utilization,
            omittedCount: result.omitted.length,
            plan: result.plan,
          });
        }

        default:
          return errorResponse(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(message);
    }
  });

  return server;
}

function jsonResponse(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResponse(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function validateArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) {
    return 'Missing tool arguments';
  }

  const task = args.task;
  if (task && typeof task === 'object') {
    const taskText = (task as { text?: unknown }).text;
    if (typeof taskText !== 'string') {
      return 'task.text must be a string';
    }
    if (taskText.length > MAX_TASK_TEXT_LENGTH) {
      return `task.text exceeds ${MAX_TASK_TEXT_LENGTH} characters`;
    }
  }

  if (typeof args.text === 'string' && args.text.length > MAX_TEXT_LENGTH) {
    return `text exceeds ${MAX_TEXT_LENGTH} characters`;
  }

  if (args.chunkIds !== undefined) {
    if (!Array.isArray(args.chunkIds)) {
      return 'chunkIds must be an array';
    }
    if (args.chunkIds.length > MAX_CHUNK_IDS) {
      return `chunkIds exceeds ${MAX_CHUNK_IDS} entries`;
    }
  }

  if (args.maxTokens !== undefined) {
    if (typeof args.maxTokens !== 'number' || !Number.isFinite(args.maxTokens) || args.maxTokens <= 0) {
      return 'maxTokens must be a positive number';
    }
  }

  return undefined;
}

export async function startMCPServer(
  pipeline: PipelineOrchestrator,
  options?: { port?: number; transport?: 'stdio' | 'sse' }
): Promise<Server> {
  const transportType = options?.transport ?? 'stdio';

  if (transportType === 'sse') {
    try {
      const [{ createServer: createHttpServer }, { SSEServerTransport }] = await Promise.all([
        import('node:http'),
        import('@modelcontextprotocol/sdk/server/sse.js'),
      ]);
      const port = options?.port ?? 3000;
      const transports = new Map<string, { transport: any; server: Server }>();

      const httpServer = createHttpServer(async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');

          if (req.method === 'GET' && url.pathname === '/sse') {
            const server = createServer(pipeline);
            const transport = new SSEServerTransport('/messages', res);
            transports.set(transport.sessionId, { transport, server });
            transport.onclose = () => {
              transports.delete(transport.sessionId);
              void server.close();
            };
            await server.connect(transport);
            return;
          }

          if (req.method === 'POST' && url.pathname === '/messages') {
            const sessionId = url.searchParams.get('sessionId');
            const entry = sessionId ? transports.get(sessionId) : undefined;
            if (!entry) {
              res.writeHead(404).end('Unknown SSE session');
              return;
            }
            await entry.transport.handlePostMessage(req, res);
            return;
          }

          res.writeHead(404).end('Not found');
        } catch (error) {
          res.writeHead(500).end('SSE transport error');
          console.error('SSE transport error:', error);
        }
      });

      await new Promise<void>((resolve) => {
        httpServer.listen(port, resolve);
      });

      console.error(`Spacefolding SSE server listening on port ${port}`);
      return createServer(pipeline);
    } catch (error) {
      console.error('SSE transport unavailable, falling back to stdio:', error);
    }
  }

  const server = createServer(pipeline);
  await server.connect(new StdioServerTransport());
  return server;
}
