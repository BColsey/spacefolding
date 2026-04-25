import type {
  CompressionProvider,
  CompressionResult,
  ContextChunk,
  TaskDescription,
} from '../types/index.js';

export interface LLMCompressionConfig {
  /** API endpoint (e.g. "https://api.openai.com/v1/chat/completions") */
  endpoint: string;
  /** API key */
  apiKey: string;
  /** Model name (e.g. "gpt-4o-mini", "claude-3-haiku-20240307") */
  model: string;
  /** Max tokens for the summary response (default: 500) */
  maxTokens?: number;
  /** Custom headers (e.g. for non-OpenAI providers) */
  headers?: Record<string, string>;
  /** Request body field name for the model (default: "model") */
  modelField?: string;
  /** Request body field name for messages (default: "messages") */
  messagesField?: string;
}

const SYSTEM_PROMPT = `You are a context compression engine for a coding assistant. Your job is to compress engineering context into a structured summary.

Rules:
- Preserve ALL constraints verbatim — never rephrase a "must" or "never" rule
- Extract key facts as short bullet points (max 2 sentences each)
- For code, list the function/class signatures and what they do
- Be concise — this summary will be fed into a prompt window
- Output format:

CONSTRAINTS:
- <each constraint>

FACTS:
- <each fact>

CODE:
- <file: signature — what it does>

COVERAGE: <N> chunks from <sources>`;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function buildDeterministicFallback(task: TaskDescription, chunks: ContextChunk[]): CompressionResult {
  const sourceChunkIds = chunks.map((c) => c.id);
  const retainedConstraints = chunks
    .filter((c) => c.type === 'constraint')
    .map((c) => truncate(c.text.trim(), 220));
  const retainedFacts = chunks
    .filter((c) => c.type === 'fact' || c.type === 'background')
    .flatMap((c) => c.text.split(/[.!?]\s/).slice(0, 2).map((s) => truncate(s.trim(), 180)))
    .slice(0, 8);

  const parts = [
    `Task: ${truncate(task.text, 220)}`,
    retainedConstraints.length > 0 ? `Constraints: ${retainedConstraints.join('; ')}` : '',
    retainedFacts.length > 0 ? `Facts: ${retainedFacts.join('; ')}` : '',
    `Coverage: ${chunks.length} chunks`,
  ].filter(Boolean);

  return {
    summary: parts.join('. ') + '.',
    retainedFacts,
    retainedConstraints,
    sourceChunkIds,
  };
}

export class LLMCompressionProvider implements CompressionProvider {
  private config: Required<Pick<LLMCompressionConfig, 'endpoint' | 'apiKey' | 'model' | 'maxTokens'>> & {
    headers: Record<string, string>;
    modelField: string;
    messagesField: string;
  };

  constructor(config: LLMCompressionConfig) {
    this.config = {
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      model: config.model,
      maxTokens: config.maxTokens ?? 500,
      headers: config.headers ?? {},
      modelField: config.modelField ?? 'model',
      messagesField: config.messagesField ?? 'messages',
    };
  }

  async compress(task: TaskDescription, chunks: ContextChunk[]): Promise<CompressionResult> {
    if (chunks.length === 0) {
      return { summary: '', retainedFacts: [], retainedConstraints: [], sourceChunkIds: [] };
    }

    const fallback = buildDeterministicFallback(task, chunks);
    const sourceChunkIds = chunks.map((c) => c.id);

    // Build the user message from chunk content
    const chunkTexts = chunks.map((c) => {
      const header = c.path
        ? `[${c.type}${c.path ? ` ${c.path}` : ''}]`
        : `[${c.type}]`;
      return `${header}\n${truncate(c.text, 2000)}`;
    });

    const userMessage = [
      `Task: ${task.text}`,
      '',
      '--- CONTEXT TO COMPRESS ---',
      ...chunkTexts,
      '--- END CONTEXT ---',
      '',
      'Compress the above context into a structured summary.',
    ].join('\n');

    try {
      const body: Record<string, unknown> = {
        [this.config.modelField]: this.config.model,
        [this.config.messagesField]: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        max_tokens: this.config.maxTokens,
        temperature: 0,
      };

      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          ...this.config.headers,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown error');
        console.error(`LLM compression API error (${response.status}): ${errorText}`);
        return fallback;
      }

      const data = await response.json() as Record<string, unknown>;
      const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
      const content = choices?.[0]?.message?.content?.trim();

      if (!content) {
        return fallback;
      }

      // Parse structured output for facts/constraints
      const retainedConstraints = extractSection(content, 'CONSTRAINTS');
      const retainedFacts = extractSection(content, 'FACTS');

      return {
        summary: content,
        retainedFacts,
        retainedConstraints,
        sourceChunkIds,
      };
    } catch (err) {
      console.error('LLM compression error:', err instanceof Error ? err.message : String(err));
      return fallback;
    }
  }
}

function extractSection(text: string, heading: string): string[] {
  const lines = text.split('\n');
  const items: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toUpperCase().startsWith(heading)) {
      inSection = true;
      continue;
    }
    // New section header — stop
    if (inSection && /^[A-Z]+:/.test(trimmed)) {
      break;
    }
    if (inSection && trimmed.startsWith('- ')) {
      items.push(trimmed.slice(2));
    }
  }

  return items;
}
