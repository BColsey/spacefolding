import type { ContextChunk, ContextTier } from '../types/index.js';
import type { RetrievalResult } from './retriever.js';

export interface ContextPackInput {
  query: string;
  chunks: ContextChunk[];
  tiers: Map<string, ContextTier>;
  totalTokens: number;
  budget: number;
  hardBudget: number;
  targetBudget: number;
  utilization: number;
  omitted: Array<{ chunkId: string; tokensEstimate: number; reason: string }>;
  dropped: Array<{ chunkId: string; reason: string }>;
  plan: {
    intent: string;
    strategy: string;
    complexity?: string;
    maxHops?: number;
  };
  retrieval: RetrievalResult[];
  selectionPolicy: {
    mode: string;
    effectiveBudget: number;
    selectedCandidates: number;
    droppedCandidates: number;
  };
}

const QUERY_METADATA_HEADING = '## Query Metadata';

export function formatContextPack(input: ContextPackInput): string {
  const retrievalByChunk = new Map(input.retrieval.map((result) => [result.chunkId, result]));
  const lines: string[] = [];

  // --- STABLE PREFIX (byte-identical across calls that share the same chunks) ---
  lines.push('# Spacefolding Context Pack');
  lines.push('');
  lines.push('## How To Use This Pack');
  lines.push('');
  lines.push('- Treat selected context as ranked evidence for the query.');
  lines.push('- Prefer earlier chunks when signals conflict; inspect lower-ranked chunks for supporting detail.');
  lines.push('- Use omitted and dropped sections as diagnostics, not as required context.');
  lines.push('');
  lines.push('## Selected Context');
  lines.push('');

  if (input.chunks.length === 0) {
    lines.push('No chunks selected. Ingest project context first or broaden the retrieval mode.');
    lines.push('');
  }

  // Per-chunk retrieval metadata (Sources/Scores/Why) is volatile per query;
  // collect it here, emit it in the trailer so it never enters the stable prefix.
  const perChunkRetrieval: string[] = [];

  input.chunks.forEach((chunk, index) => {
    const baseChunkId = baseRetrievalId(chunk);
    const retrieval = retrievalByChunk.get(baseChunkId);
    const tier = input.tiers.get(chunk.id) ?? 'warm';
    const title = chunk.path ?? chunk.source ?? chunk.type;
    const reasons = retrieval?.reasons.filter((reason) => !reason.startsWith('scores ')).slice(0, 5) ?? [];

    lines.push(`### ${index + 1}. ${title} [${tier}]`);
    lines.push('');
    lines.push(`- Chunk: \`${safeInlineCode(chunk.id)}\``);
    if (baseChunkId !== chunk.id) lines.push(`- Original chunk: \`${safeInlineCode(baseChunkId)}\``);
    lines.push(`- Type: ${chunk.type}`);
    lines.push(`- Tokens: ${chunk.tokensEstimate}`);
    lines.push('');
    lines.push(`~~~${languageHint(chunk)}`);
    lines.push(chunk.text.trimEnd());
    lines.push('~~~');
    lines.push('');

    // Volatile per-query retrieval signals -> trailer.
    if (retrieval) {
      perChunkRetrieval.push(`### ${index + 1}. ${title}`);
      perChunkRetrieval.push('');
      perChunkRetrieval.push(`- Sources: ${retrieval.sources.join('+') || 'unknown'}`);
      if (retrieval.sourceScores) perChunkRetrieval.push(`- Scores: ${formatScores(retrieval.sourceScores)}`);
      if (reasons.length > 0) perChunkRetrieval.push(`- Why: ${reasons.map(oneLine).join('; ')}`);
      perChunkRetrieval.push('');
    }
  });

  // --- VOLATILE TRAILER ---
  lines.push(QUERY_METADATA_HEADING);
  lines.push('');
  lines.push(`Query: ${input.query}`);
  lines.push(
    `Intent: ${input.plan.intent} | Strategy: ${input.plan.strategy} | Mode: ${input.selectionPolicy.mode}`
  );
  if (typeof input.plan.maxHops === 'number') {
    lines.push(`Graph hops: ${input.plan.maxHops}`);
  }
  lines.push(
    `Tokens: ${input.totalTokens}/${input.targetBudget} target (${input.hardBudget} hard cap, ${formatPercent(input.utilization)} used)`
  );
  lines.push(`Candidates: ${input.selectionPolicy.selectedCandidates} selected, ${input.selectionPolicy.droppedCandidates} dropped`);
  lines.push('');

  if (perChunkRetrieval.length > 0) {
    lines.push('## Per-Chunk Retrieval');
    lines.push('');
    lines.push(...perChunkRetrieval);
  }

  if (input.omitted.length > 0) {
    lines.push('## Omitted By Budget');
    lines.push('');
    for (const omitted of input.omitted.slice(0, 12)) {
      lines.push(`- \`${safeInlineCode(omitted.chunkId)}\` (${omitted.tokensEstimate} tokens): ${oneLine(omitted.reason)}`);
    }
    if (input.omitted.length > 12) {
      lines.push(`- ${input.omitted.length - 12} more omitted chunks not shown.`);
    }
    lines.push('');
  }

  if (input.dropped.length > 0) {
    lines.push('## Dropped Candidate Diagnostics');
    lines.push('');
    for (const dropped of input.dropped.slice(0, 12)) {
      lines.push(`- \`${safeInlineCode(dropped.chunkId)}\`: ${oneLine(dropped.reason)}`);
    }
    if (input.dropped.length > 12) {
      lines.push(`- ${input.dropped.length - 12} more dropped candidates not shown.`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

function baseRetrievalId(chunk: ContextChunk): string {
  const compressedFrom = chunk.metadata?.compressedFrom;
  if (typeof compressedFrom === 'string' && compressedFrom.length > 0) return compressedFrom;
  return chunk.id.endsWith('__compressed') ? chunk.id.slice(0, -'__compressed'.length) : chunk.id;
}

function languageHint(chunk: ContextChunk): string {
  const candidate = chunk.language ?? languageFromPath(chunk.path);
  if (!candidate) return '';
  const normalized = candidate.toLowerCase();
  return /^[a-z0-9_+-]+$/.test(normalized) ? normalized : '';
}

function languageFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
  if (path.endsWith('.js') || path.endsWith('.jsx')) return 'javascript';
  if (path.endsWith('.py')) return 'python';
  if (path.endsWith('.rs')) return 'rust';
  if (path.endsWith('.go')) return 'go';
  if (path.endsWith('.java')) return 'java';
  if (path.endsWith('.md')) return 'markdown';
  if (path.endsWith('.json')) return 'json';
  return undefined;
}

function formatScores(scores: NonNullable<RetrievalResult['sourceScores']>): string {
  return [
    `final=${scores.final.toFixed(3)}`,
    `structural=${scores.structural.toFixed(3)}`,
    `fts=${scores.fts.toFixed(3)}`,
    `vector=${scores.vector.toFixed(3)}`,
    `graph=${scores.graph.toFixed(3)}`,
    `dependency=${scores.dependency.toFixed(3)}`,
  ].join(' ');
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function safeInlineCode(value: string): string {
  return value.replace(/`/g, "'");
}
