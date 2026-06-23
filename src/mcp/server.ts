import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import type { RetrievalMode, RetrievalStrategy } from '../types/index.js';
import { RETRIEVAL_MODES, RETRIEVAL_STRATEGIES } from '../types/index.js';
import { formatContextPack } from '../core/context-pack.js';
import { createIngestPolicy } from '../security/ingest-policy.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const USE_GPU = process.env.USE_GPU === '1';
const MAX_TASK_TEXT_LENGTH = 10_000;
const MAX_TEXT_LENGTH = 100_000;
const MAX_CHUNK_IDS = 1_000;

const VALID_STRATEGIES: readonly string[] = RETRIEVAL_STRATEGIES;
const VALID_MODES: readonly string[] = RETRIEVAL_MODES;
const VALID_RETRIEVE_FORMATS = ['json', 'pack'] as const;
const VALID_GRAPH_OPERATIONS = ['add', 'remove'] as const;
const VALID_DEPENDENCY_TYPES = ['references', 'defines', 'summarizes', 'overrides', 'contains'] as const;
/** The 9-value chunk-type enum shared by ingest_context (alias) and ingest (canonical). */
const VALID_INGEST_TYPES = ['fact', 'constraint', 'instruction', 'code', 'log', 'background', 'summary', 'diff', 'reference'] as const;

function describeTool(description: string): string {
  return USE_GPU
    ? `${description} GPU acceleration is enabled when the runtime supports it.`
    : description;
}

export const TOOL_DEFINITIONS = [
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
    annotations: { readOnlyHint: true },
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
    annotations: { destructiveHint: false },
    inputSchema: {
      type: 'object' as const,
      properties: {
        source: { type: 'string', description: 'Where this context came from' },
        text: { type: 'string', description: 'The context text' },
        type: {
          type: 'string',
          enum: ['fact', 'constraint', 'instruction', 'code', 'log', 'background', 'summary', 'diff', 'reference'],
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
    annotations: { destructiveHint: true },
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
    annotations: { readOnlyHint: true },
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
      'Retrieve relevant context using focused structural/vector/text search with automatic budget control'
    ),
    annotations: { readOnlyHint: true },
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
          enum: RETRIEVAL_STRATEGIES,
          description: 'Retrieval strategy (default: structural when code symbols are indexed, otherwise adaptive based on embedding provider)',
        },
        mode: {
          type: 'string',
          enum: RETRIEVAL_MODES,
          description: 'Selection mode: focused returns compact high-confidence context, broad returns more coverage, exhaustive preserves legacy breadth',
        },
        topK: {
          type: 'number',
          description: 'Max retrieval candidates before selection and token budgeting (default: adaptive by query intent)',
        },
        returnLimit: {
          type: 'number',
          description: 'Max scored candidates to consider after retrieval and before token budgeting',
        },
        maxHops: {
          type: 'number',
          description: 'Max dependency graph traversal hops (default: 1 for graph strategy, 0 otherwise; graph traversal is disabled unless requested)',
        },
        format: {
          type: 'string',
          enum: VALID_RETRIEVE_FORMATS,
          description: 'Response format: json returns structured fields; pack returns an agent-ready Markdown context pack',
        },
        explain: {
          type: 'boolean',
          description:
            'When true, fold explain_routing into the response: include a routingExplanation object (per-chunk tier/score/reasons + summary) describing why retrieved chunks were routed to their tiers',
        },
        score: {
          type: 'boolean',
          description:
            'When true, fold score_context into the response: score+route all chunks into hot/warm/cold tiers for this query and include the routing (hot/warm/cold id lists + scores + reasons) in the response',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'iterative_retrieve',
    description: describeTool(
      'Multi-round iterative retrieval: retrieves context, expands query from results, re-retrieves for broader coverage'
    ),
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Initial search query',
        },
        maxTokens: {
          type: 'number',
          description: 'Maximum total token budget across all rounds (default: 100000)',
        },
        rounds: {
          type: 'number',
          description: 'Number of retrieval iterations (default: 2)',
        },
        strategy: {
          type: 'string',
          enum: RETRIEVAL_STRATEGIES,
          description: 'Retrieval strategy per round (default: structural when code symbols are indexed, otherwise adaptive)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'ingest_project',
    description: describeTool(
      'Ingest a project with source code plus README, docs, env examples, config files, and agent instructions'
    ),
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to project directory to ingest',
        },
        includeDocs: {
          type: 'boolean',
          description: 'Include docs/**/*.md and README files (default: true)',
        },
        includeTests: {
          type: 'boolean',
          description: 'Include test/spec files and test directories (default: false)',
        },
        includeBenchmarks: {
          type: 'boolean',
          description: 'Include benchmark directories (default: false)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'ingest_directory',
    description: describeTool(
      'Ingest all files in a directory tree. Skips node_modules, .git, dist, and binary files.'
    ),
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to directory to ingest',
        },
        type: {
          type: 'string',
          description: 'Optional chunk type override for all files',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_context',
    description: describeTool(
      'Show what context has been ingested: chunk counts, token totals, per-file breakdown'
    ),
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'delete_context',
    description: describeTool(
      'Delete specific context chunks by ID'
    ),
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        chunkIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Chunk IDs to delete',
        },
      },
      required: ['chunkIds'],
    },
  },
];

/**
 * Canonical tool surface — what ListTools advertises to agents.
 *
 * Goal: a token-cheap surface (4 tools) instead of the historical 12. The full
 * 12-name set in TOOL_DEFINITIONS is kept for backward compatibility: every old
 * name remains callable via CallTool (they route to the same handlers as
 * aliases). Only the 4 canonical names are advertised.
 *
 * Canonical tools:
 *  - retrieve_context: focused retrieval (with optional explain/score folds).
 *  - ingest: unified ingest (item | project | directory | auto).
 *  - get_context_for_task: composite (ensure-ingested -> retrieve -> pack).
 *  - get_relevant_memory: cold/warm memory search (distinct from retrieve).
 */
export const CANONICAL_TOOL_DEFINITIONS = [
  // 1. retrieve_context (canonical copy; mirrors the alias in TOOL_DEFINITIONS).
  {
    name: 'retrieve_context',
    description: describeTool(
      'Retrieve relevant context using focused structural/vector/text search with automatic budget control. Optional flags fold explain_routing (explain=true) and score_context (score=true) into the response.'
    ),
    annotations: { readOnlyHint: true },
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
          enum: RETRIEVAL_STRATEGIES,
          description: 'Retrieval strategy (default: structural when code symbols are indexed, otherwise adaptive based on embedding provider)',
        },
        mode: {
          type: 'string',
          enum: RETRIEVAL_MODES,
          description: 'Selection mode: focused returns compact high-confidence context, broad returns more coverage, exhaustive preserves legacy breadth',
        },
        topK: {
          type: 'number',
          description: 'Max retrieval candidates before selection and token budgeting (default: adaptive by query intent)',
        },
        returnLimit: {
          type: 'number',
          description: 'Max scored candidates to consider after retrieval and before token budgeting',
        },
        maxHops: {
          type: 'number',
          description: 'Max dependency graph traversal hops (default: 1 for graph strategy, 0 otherwise; graph traversal is disabled unless requested)',
        },
        format: {
          type: 'string',
          enum: VALID_RETRIEVE_FORMATS,
          description: 'Response format: json returns structured fields; pack returns an agent-ready Markdown context pack',
        },
        explain: {
          type: 'boolean',
          description:
            'When true, fold explain_routing into the response: include a routingExplanation object (per-chunk tier/score/reasons + summary) describing why retrieved chunks were routed to their tiers',
        },
        score: {
          type: 'boolean',
          description:
            'When true, fold score_context into the response: score+route all chunks into hot/warm/cold tiers for this query and include the routing (hot/warm/cold id lists + scores + reasons) in the response',
        },
      },
      required: ['query'],
    },
  },
  // 2. ingest (unified).
  {
    name: 'ingest',
    description: describeTool(
      'Unified ingest. By default (mode=auto) detects intent: content present -> ingest a single item; else path is a directory or project root to index. Use mode=item|project|directory to be explicit. Path modes are confined to SF_INGEST_ROOTS.'
    ),
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        mode: {
          type: 'string',
          enum: ['auto', 'item', 'project', 'directory'],
          description: 'Ingest mode (default: auto). item ingests a single content string; project/directory index a path tree.',
        },
        path: {
          type: 'string',
          description: 'Absolute path to ingest (project/directory modes). Must be within SF_INGEST_ROOTS.',
        },
        content: {
          type: 'string',
          description: 'The context text to ingest (item mode). Alias for the text body.',
        },
        source: {
          type: 'string',
          description: 'Where this context came from (item mode, e.g. "file", "diff", "log").',
        },
        type: {
          type: 'string',
          enum: ['fact', 'constraint', 'instruction', 'code', 'log', 'background', 'summary', 'diff', 'reference'],
          description: 'Chunk type for item mode, or an optional override type for directory mode.',
        },
        language: {
          type: 'string',
          description: 'Programming language if code (item mode).',
        },
        includeDocs: { type: 'boolean', description: 'project mode: include docs/**/*.md and README files (default: true)' },
        includeTests: { type: 'boolean', description: 'project mode: include test/spec files and test directories (default: false)' },
        includeBenchmarks: { type: 'boolean', description: 'project mode: include benchmark directories (default: false)' },
      },
    },
  },
  // 3. get_context_for_task (composite).
  {
    name: 'get_context_for_task',
    description: describeTool(
      'One-shot composite: if the index is empty and rootPath is within SF_INGEST_ROOTS, ingest that project first; then retrieve context for the task and pack it into the token budget. Returns ready-to-use context in a single call.'
    ),
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        task: {
          type: 'string',
          description: 'The task to gather context for (used as the retrieval query).',
        },
        rootPath: {
          type: 'string',
          description: 'Optional project root to ingest first if the index is empty. Must be within SF_INGEST_ROOTS.',
        },
        maxTokens: {
          type: 'number',
          description: 'Maximum token budget for the packed context (default: auto).',
        },
        strategy: {
          type: 'string',
          enum: RETRIEVAL_STRATEGIES,
          description: 'Retrieval strategy pass-through (default: structural when code symbols are indexed, otherwise adaptive).',
        },
        mode: {
          type: 'string',
          enum: RETRIEVAL_MODES,
          description: 'Selection mode pass-through.',
        },
      },
      required: ['task'],
    },
  },
  // 4. get_relevant_memory.
  {
    name: 'get_relevant_memory',
    description: describeTool(
      'Retrieve context chunks from warm/cold storage that are relevant to a task'
    ),
    annotations: { readOnlyHint: true },
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
];

/**
 * Canonical names advertised by ListTools.
 */
export const CANONICAL_TOOL_NAMES = new Set(
  CANONICAL_TOOL_DEFINITIONS.map((tool) => tool.name)
);

/**
 * Gate set for CallTool: the union of canonical names AND all legacy aliases.
 * Every old tool name remains callable (backward compatibility invariant).
 */
const TOOL_NAMES = new Set([
  ...CANONICAL_TOOL_NAMES,
  ...TOOL_DEFINITIONS.map((tool) => tool.name),
]);

/**
 * Maps legacy tool names to the canonical handler they should dispatch to.
 * Names not present here are handled by their own dedicated case (canonical
 * names, plus alias-only tools whose internals are not folded into a canonical
 * tool: compress_context, update_context_graph, delete_context, list_context,
 * iterative_retrieve).
 */
const ALIAS_TO_HANDLER: Record<string, string> = {
  ingest_context: 'ingest',
  ingest_project: 'ingest',
  ingest_directory: 'ingest',
  score_context: 'retrieve_context',
  explain_routing: 'retrieve_context',
};

export function createMCPServer(pipeline: PipelineOrchestrator): Server {
  // Trust boundary: confine ingest paths to the configured roots (cwd +
  // SF_INGEST_ROOTS). Without this an agent could ingest arbitrary absolute
  // paths (e.g. ~/.ssh). See src/security/ingest-policy.ts.
  const ingestPolicy = createIngestPolicy();
  const server = new Server(
    { name: 'spacefolding', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  // ListTools advertises ONLY the canonical surface. Legacy names stay callable
  // via CallTool (see TOOL_NAMES union + ALIAS_TO_HANDLER), they are simply not
  // advertised — keeping the advertised token cost low.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: CANONICAL_TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!TOOL_NAMES.has(name)) {
      return errorResponse(`Unknown tool: ${name}`);
    }

    const validationError = validateArgs(args as Record<string, unknown> | undefined, name);
    if (validationError) {
      return errorResponse(validationError);
    }

    try {
      switch (name) {
        case 'score_context': {
          const chunkIds = (args!.chunkIds as string[] | undefined)?.slice(0, MAX_CHUNK_IDS);
          const allowedChunkIds = chunkIds ? new Set(chunkIds) : undefined;
          const result = await pipeline.processContext(
            {
              ...(args!.task as { text: string; type?: string; priority?: string }),
              maxTokens: args!.maxTokens as number | undefined,
            } as { text: string; type?: string; priority?: string; maxTokens?: number },
            undefined,
            { chunkIds }
          );
          if (!allowedChunkIds) {
            return jsonResponse(result);
          }
          return jsonResponse({
            ...result,
            hot: result.hot.filter((id) => allowedChunkIds.has(id)),
            warm: result.warm.filter((id) => allowedChunkIds.has(id)),
            cold: result.cold.filter((id) => allowedChunkIds.has(id)),
            scores: Object.fromEntries(
              Object.entries(result.scores).filter(([chunkId]) => allowedChunkIds.has(chunkId))
            ),
            reasons: Object.fromEntries(
              Object.entries(result.reasons).filter(([chunkId]) => allowedChunkIds.has(chunkId))
            ),
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
          if (pipeline.getStats().totalChunks === 0) {
            return jsonResponse(emptyIndexHint());
          }
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
          const chunk = await pipeline.ingest(
            args!.source as string,
            args!.text as string,
            args!.type as string | undefined,
            args!.path as string | undefined,
            args!.language as string | undefined
          );
          const result: { chunkId: string; split?: { childCount: number; childIds: string[] } } = {
            chunkId: chunk.id,
          };
          if (chunk.childrenIds.length > 0) {
            result.split = { childCount: chunk.childrenIds.length, childIds: chunk.childrenIds };
          }
          return jsonResponse(result);
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
          if (pipeline.getStats().totalChunks === 0) {
            return jsonResponse(emptyIndexHint());
          }
          const maxTokens = args!.maxTokens as number | undefined;
          const strategy = args!.strategy as RetrievalStrategy | undefined;
          const mode = args!.mode as RetrievalMode | undefined;
          const topK = args!.topK as number | undefined;
          const returnLimit = args!.returnLimit as number | undefined;
          const maxHops = args!.maxHops as number | undefined;
          const format = (args!.format as string | undefined) ?? 'json';
          const explain = args!.explain === true;
          const score = args!.score === true;

          const result = await pipeline.retrieve(query, maxTokens, { strategy, mode, topK, returnLimit, maxHops });
          if (format === 'pack') {
            return textResponse(formatContextPack({ query, ...result }));
          }
          const folded: Record<string, unknown> = {};
          if (explain) {
            // Fold explain_routing: per-chunk tier/score/reasons + summary.
            const explanation = await pipeline.explainRouting({ text: query });
            folded.routingExplanation = explanation;
          }
          if (score) {
            // Fold score_context: hot/warm/cold id lists + scores + reasons.
            const scored = await pipeline.processContext(
              { text: query },
              undefined,
              {}
            );
            folded.routing = {
              hot: scored.hot,
              warm: scored.warm,
              cold: scored.cold,
              scores: scored.scores,
              reasons: scored.reasons,
            };
          }
          return jsonResponse({
            chunks: result.chunks.map((c) => ({
              id: c.id,
              type: c.type,
              text: c.text,
              path: c.path,
              tokensEstimate: c.tokensEstimate,
              tier: result.tiers.get(c.id) ?? 'warm',
              compressedFrom: c.metadata?.compressedFrom ?? undefined,
              retrievalSources: result.retrieval.find((r) => r.chunkId === c.id.split('__compressed')[0])?.sources ?? [],
              retrievalScores: result.retrieval.find((r) => r.chunkId === c.id.split('__compressed')[0])?.sourceScores ?? undefined,
              retrievalReasons: result.retrieval.find((r) => r.chunkId === c.id.split('__compressed')[0])?.reasons ?? [],
            })),
            totalTokens: result.totalTokens,
            budget: result.budget,
            hardBudget: result.hardBudget,
            targetBudget: result.targetBudget,
            utilization: result.utilization,
            omittedCount: result.omitted.length,
            omitted: result.omitted,
            droppedCount: result.dropped.length,
            dropped: result.dropped,
            compressedCount: result.compressed.length,
            compressedSummaries: result.compressed.map((c) => ({
              originalChunkId: c.chunkId,
              tokensEstimate: c.tokensEstimate,
            })),
            plan: result.plan,
            selectionPolicy: result.selectionPolicy,
            ...folded,
          });
        }

        case 'iterative_retrieve': {
          const query = args!.query as string;
          if (pipeline.getStats().totalChunks === 0) {
            return jsonResponse(emptyIndexHint());
          }
          const maxTokens = (args!.maxTokens as number | undefined) ?? 100_000;
          const rounds = (args!.rounds as number | undefined) ?? 2;
          const strategy = args!.strategy as RetrievalStrategy | undefined;

          const result = await pipeline.iterativeRetrieve(query, rounds, maxTokens, { strategy });
          return jsonResponse({
            rounds: result.rounds.map((r) => ({
              round: r.round,
              query: r.query,
              newChunkCount: r.newChunkCount,
              chunks: r.chunks.map((c) => ({
                id: c.id,
                type: c.type,
                text: c.text,
                path: c.path,
                tokensEstimate: c.tokensEstimate,
                tier: result.finalTiers.get(c.id) ?? 'warm',
              })),
            })),
            totalChunks: result.finalChunks.length,
            totalTokens: result.totalTokens,
            budget: result.budget,
          });
        }

        case 'ingest_project': {
          const dirPath = args!.path as string;
          if (typeof dirPath !== 'string' || dirPath.length === 0) {
            return errorResponse('path must be a non-empty string');
          }
          const ingestDenied = ingestPolicy.assertAllowed(dirPath);
          if (ingestDenied) {
            return errorResponse(ingestDenied);
          }
          const result = await pipeline.ingestProject(dirPath, {
            includeDocs: args!.includeDocs as boolean | undefined,
            includeTests: args!.includeTests as boolean | undefined,
            includeBenchmarks: args!.includeBenchmarks as boolean | undefined,
          });
          return jsonResponse(result);
        }

        case 'ingest_directory': {
          const dirPath = args!.path as string;
          if (typeof dirPath !== 'string' || dirPath.length === 0) {
            return errorResponse('path must be a non-empty string');
          }
          const ingestDenied = ingestPolicy.assertAllowed(dirPath);
          if (ingestDenied) {
            return errorResponse(ingestDenied);
          }
          const result = await pipeline.ingestDirectory(dirPath, args!.type as string | undefined);
          return jsonResponse(result);
        }

        case 'list_context': {
          const stats = pipeline.getStats();
          return jsonResponse(stats);
        }

        case 'delete_context': {
          const chunkIds = ((args!.chunkIds as string[]) ?? []).slice(0, MAX_CHUNK_IDS);
          if (chunkIds.length === 0) {
            return errorResponse('chunkIds must be a non-empty array');
          }
          const deleted = pipeline.deleteChunks(chunkIds);
          return jsonResponse({ deleted });
        }

        // --- Canonical handlers (new in WS2.2 tool-surface collapse) ---

        case 'ingest': {
          const mode = (args!.mode as string | undefined) ?? 'auto';
          const content = args!.content as string | undefined;
          const pathArg = args!.path as string | undefined;

          if (mode === 'item' || (mode === 'auto' && content !== undefined)) {
            // Single-item ingest (folds ingest_context). content or text both
            // accepted; source defaults to 'inline'.
            const text = content ?? (args!.text as string | undefined);
            if (typeof text !== 'string' || text.length === 0) {
              return errorResponse('content (or text) must be a non-empty string for item ingest');
            }
            const source = (args!.source as string | undefined) ?? 'inline';
            const chunk = await pipeline.ingest(
              source,
              text,
              args!.type as string | undefined,
              args!.path as string | undefined,
              args!.language as string | undefined
            );
            const result: { chunkId: string; mode: string; split?: { childCount: number; childIds: string[] } } = {
              chunkId: chunk.id,
              mode: 'item',
            };
            if (chunk.childrenIds.length > 0) {
              result.split = { childCount: chunk.childrenIds.length, childIds: chunk.childrenIds };
            }
            return jsonResponse(result);
          }

          // Path modes (project | directory | auto-with-path).
          if (typeof pathArg !== 'string' || pathArg.length === 0) {
            return errorResponse('path must be a non-empty string for project/directory ingest');
          }
          const ingestDenied = ingestPolicy.assertAllowed(pathArg);
          if (ingestDenied) {
            return errorResponse(ingestDenied);
          }
          const looksLikeProject = mode === 'project'
            || (mode === 'auto' && hasProjectMarker(pathArg));
          if (looksLikeProject) {
            const result = await pipeline.ingestProject(pathArg, {
              includeDocs: args!.includeDocs as boolean | undefined,
              includeTests: args!.includeTests as boolean | undefined,
              includeBenchmarks: args!.includeBenchmarks as boolean | undefined,
            });
            return jsonResponse({ ...result, mode: 'project' });
          }
          const result = await pipeline.ingestDirectory(pathArg, args!.type as string | undefined);
          return jsonResponse({ ...result, mode: 'directory' });
        }

        case 'get_context_for_task': {
          const task = args!.task as string;
          const rootPath = args!.rootPath as string | undefined;

          // Self-heal: if the index is empty, ingest first (only if a rootPath is
          // supplied AND it is within the allowed ingest roots). Never ingest
          // outside allowed roots.
          if (pipeline.getStats().totalChunks === 0) {
            if (typeof rootPath === 'string' && rootPath.length > 0) {
              const ingestDenied = ingestPolicy.assertAllowed(rootPath);
              if (ingestDenied) {
                return errorResponse(ingestDenied);
              }
              await pipeline.ingestProject(rootPath, {});
              // If ingest still left the index empty (e.g. empty dir), fall
              // through to the hint below rather than retrieving against 0.
              if (pipeline.getStats().totalChunks === 0) {
                return jsonResponse(emptyIndexHint());
              }
            } else {
              return jsonResponse(emptyIndexHint());
            }
          }

          const maxTokens = args!.maxTokens as number | undefined;
          const strategy = args!.strategy as RetrievalStrategy | undefined;
          const mode = args!.mode as RetrievalMode | undefined;
          const result = await pipeline.retrieve(task, maxTokens, { strategy, mode });
          return jsonResponse({
            task,
            chunks: result.chunks.map((c) => ({
              id: c.id,
              type: c.type,
              text: c.text,
              path: c.path,
              tokensEstimate: c.tokensEstimate,
              tier: result.tiers.get(c.id) ?? 'warm',
            })),
            totalTokens: result.totalTokens,
            budget: result.budget,
            hardBudget: result.hardBudget,
            targetBudget: result.targetBudget,
            utilization: result.utilization,
            plan: result.plan,
            selectionPolicy: result.selectionPolicy,
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

function textResponse(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
  };
}

function errorResponse(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

/**
 * Conservative heuristic used by the unified `ingest` tool in auto mode to
 * decide whether a directory should be ingested as a project (with docs/agent
 * instructions/context files) or as a plain directory tree. Only consulted in
 * auto mode; explicit mode=item|project|directory always wins.
 */
function hasProjectMarker(dirPath: string): boolean {
  const markers = [
    'package.json',
    '.git',
    'pyproject.toml',
    'Cargo.toml',
    'go.mod',
    'pom.xml',
    'tsconfig.json',
    'CLAUDE.md',
  ];
  return markers.some((marker) => existsSync(join(dirPath, marker)));
}

/**
 * Self-healing response returned when an agent retrieves against an empty index.
 * Replaces the bare empty envelope with an actionable hint, so the agent learns
 * to ingest first instead of treating silence as "nothing matched".
 */
function emptyIndexHint() {
  return {
    hint:
      'The Spacefolding index is empty — no context has been ingested yet. Call ingest_project or ingest_directory to index a codebase first; retrieve_context / get_relevant_memory will then return relevant chunks.',
    empty: true,
    suggestedTools: ['ingest_project', 'ingest_directory'],
    chunks: [] as unknown[],
  };
}

export function validateArgs(args: Record<string, unknown> | undefined, toolName?: string): string | undefined {
  if (!args) {
    if (!toolName) {
      return 'Missing tool arguments';
    }
    args = {};
  }

  if (toolName === 'retrieve_context' || toolName === 'iterative_retrieve') {
    if (typeof args.query !== 'string' || args.query.trim().length === 0) {
      return 'query must be a non-empty string';
    }
  }

  if (toolName === 'retrieve_context' && args.format !== undefined) {
    if (!VALID_RETRIEVE_FORMATS.includes(args.format as typeof VALID_RETRIEVE_FORMATS[number])) {
      return `format must be one of: ${VALID_RETRIEVE_FORMATS.join(', ')}`;
    }
  }

  if (
    toolName === 'score_context' ||
    toolName === 'compress_context' ||
    toolName === 'get_relevant_memory' ||
    toolName === 'explain_routing'
  ) {
    if (!args.task || typeof args.task !== 'object') {
      return 'task must be an object with text string';
    }
  }

  if (toolName === 'ingest_context') {
    if (typeof args.source !== 'string' || args.source.trim().length === 0) {
      return 'source must be a non-empty string';
    }
    if (typeof args.text !== 'string' || args.text.length === 0) {
      return 'text must be a non-empty string';
    }
    if (args.type !== undefined && !VALID_INGEST_TYPES.includes(args.type as typeof VALID_INGEST_TYPES[number])) {
      return `type must be one of: ${VALID_INGEST_TYPES.join(', ')}`;
    }
  }

  if (toolName === 'ingest_project' || toolName === 'ingest_directory') {
    if (typeof args.path !== 'string' || args.path.trim().length === 0) {
      return 'path must be a non-empty string';
    }
  }

  // Canonical tools (WS2.2).
  if (toolName === 'ingest') {
    const VALID_INGEST_MODES = ['auto', 'item', 'project', 'directory'];
    if (args.mode !== undefined && !VALID_INGEST_MODES.includes(args.mode as string)) {
      return `mode must be one of: ${VALID_INGEST_MODES.join(', ')}`;
    }
    const mode = (args.mode as string | undefined) ?? 'auto';
    const hasContent = typeof args.content === 'string' || typeof args.text === 'string';
    // item/auto-with-content needs content; project/directory/auto-with-path needs path.
    if (mode === 'item' && !hasContent) {
      return 'content (or text) must be a non-empty string for item ingest';
    }
    if ((mode === 'project' || mode === 'directory') && typeof args.path !== 'string') {
      return 'path must be a non-empty string for project/directory ingest';
    }
    if (mode === 'auto' && !hasContent && typeof args.path !== 'string') {
      return 'ingest requires either content (item) or path (project/directory)';
    }
    if (args.type !== undefined && !VALID_INGEST_TYPES.includes(args.type as typeof VALID_INGEST_TYPES[number])) {
      return `type must be one of: ${VALID_INGEST_TYPES.join(', ')}`;
    }
  }

  if (toolName === 'get_context_for_task') {
    if (typeof args.task !== 'string' || args.task.trim().length === 0) {
      return 'task must be a non-empty string';
    }
    if (args.task.length > MAX_TASK_TEXT_LENGTH) {
      return `task exceeds ${MAX_TASK_TEXT_LENGTH} characters`;
    }
  }

  if (toolName === 'compress_context' || toolName === 'delete_context') {
    if (!Array.isArray(args.chunkIds) || args.chunkIds.length === 0) {
      return 'chunkIds must be a non-empty array';
    }
  }

  if (toolName === 'update_context_graph') {
    if (typeof args.chunkId !== 'string' || args.chunkId.trim().length === 0) {
      return 'chunkId must be a non-empty string';
    }
    if (!VALID_GRAPH_OPERATIONS.includes(args.operation as typeof VALID_GRAPH_OPERATIONS[number])) {
      return `operation must be one of: ${VALID_GRAPH_OPERATIONS.join(', ')}`;
    }
    if (!Array.isArray(args.dependencies) || args.dependencies.length === 0) {
      return 'dependencies must be a non-empty array';
    }
    for (const [index, dependency] of args.dependencies.entries()) {
      if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) {
        return `dependencies[${index}] must be an object`;
      }
      const link = dependency as Record<string, unknown>;
      if (typeof link.fromId !== 'string' || link.fromId.trim().length === 0) {
        return `dependencies[${index}].fromId must be a non-empty string`;
      }
      if (typeof link.toId !== 'string' || link.toId.trim().length === 0) {
        return `dependencies[${index}].toId must be a non-empty string`;
      }
      if (!VALID_DEPENDENCY_TYPES.includes(link.type as typeof VALID_DEPENDENCY_TYPES[number])) {
        return `dependencies[${index}].type must be one of: ${VALID_DEPENDENCY_TYPES.join(', ')}`;
      }
      if (link.weight !== undefined && (typeof link.weight !== 'number' || !Number.isFinite(link.weight))) {
        return `dependencies[${index}].weight must be a finite number`;
      }
    }
  }

  if (args.query !== undefined) {
    if (typeof args.query !== 'string' || args.query.trim().length === 0) {
      return 'query must be a non-empty string';
    }
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

  if (typeof args.path === 'string' && args.path.length > 4096) {
    return `path exceeds 4096 characters`;
  }

  if (args.chunkIds !== undefined) {
    if (!Array.isArray(args.chunkIds)) {
      return 'chunkIds must be an array';
    }
    if (args.chunkIds.length > MAX_CHUNK_IDS) {
      return `chunkIds exceeds ${MAX_CHUNK_IDS} entries`;
    }
    if (!args.chunkIds.every((chunkId) => typeof chunkId === 'string' && chunkId.length > 0)) {
      return 'chunkIds must contain non-empty strings';
    }
  }

  if (args.maxTokens !== undefined) {
    if (
      typeof args.maxTokens !== 'number' ||
      !Number.isSafeInteger(args.maxTokens) ||
      args.maxTokens <= 0
    ) {
      return 'maxTokens must be a positive integer';
    }
  }

  for (const key of ['topK', 'returnLimit'] as const) {
    if (args[key] !== undefined) {
      if (typeof args[key] !== 'number' || !Number.isSafeInteger(args[key]) || args[key] <= 0) {
        return `${key} must be a positive integer`;
      }
    }
  }

  if (args.rounds !== undefined) {
    if (typeof args.rounds !== 'number' || !Number.isSafeInteger(args.rounds) || args.rounds <= 0) {
      return 'rounds must be a positive integer';
    }
  }

  if (args.maxHops !== undefined) {
    if (typeof args.maxHops !== 'number' || !Number.isSafeInteger(args.maxHops) || args.maxHops < 0) {
      return 'maxHops must be a non-negative integer';
    }
  }

  if (args.strategy !== undefined) {
    if (!VALID_STRATEGIES.includes(args.strategy as string)) {
      return `strategy must be one of: ${VALID_STRATEGIES.join(', ')}`;
    }
  }

  if (args.mode !== undefined && toolName !== 'ingest') {
    // Note: `ingest` has its own `mode` param (auto/item/project/directory),
    // validated above against VALID_INGEST_MODES. The retrieval-mode enum here
    // applies to retrieve_context / iterative_retrieve / get_context_for_task.
    if (!VALID_MODES.includes(args.mode as string)) {
      return `mode must be one of: ${VALID_MODES.join(', ')}`;
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
            const server = createMCPServer(pipeline);
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
      return createMCPServer(pipeline);
    } catch (error) {
      console.error('SSE transport unavailable, falling back to stdio:', error);
    }
  }

  const server = createMCPServer(pipeline);
  await server.connect(new StdioServerTransport());
  return server;
}
