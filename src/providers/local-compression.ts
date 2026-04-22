import type {
  CompressionProvider,
  CompressionResult,
  ContextChunk,
  TaskDescription,
} from '../types/index.js';
import { env, pipeline } from '@huggingface/transformers';

env.allowLocalModels = true;
env.localModelPath = process.env.MODEL_PATH ?? './data/models';
env.useBrowserCache = false;

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'along', 'also', 'because', 'before', 'being', 'between',
  'could', 'first', 'from', 'have', 'into', 'just', 'more', 'most', 'only', 'other', 'over',
  'same', 'should', 'some', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these',
  'this', 'those', 'through', 'under', 'very', 'what', 'when', 'where', 'which', 'while', 'with',
  'would', 'your', 'task', 'code', 'file', 'files', 'text', 'chunk', 'chunks'
]);

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function extractCodeSignatures(text: string): string[] {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const matches = lines.filter((line) =>
    /^(export\s+)?(async\s+)?function\s+\w+|^class\s+\w+|^(export\s+)?interface\s+\w+|^(export\s+)?type\s+\w+|^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?\([^)]*\)\s*=>/.test(line)
  );
  return matches.slice(0, 6).map((line) => truncate(line, 120));
}

function extractKeywords(task: TaskDescription, chunks: ContextChunk[]): string[] {
  const counts = new Map<string, number>();
  const input = [task.text, ...chunks.map((chunk) => chunk.text)].join(' ').toLowerCase();
  for (const word of input.match(/[a-z][a-z0-9_-]{3,}/g) ?? []) {
    if (STOP_WORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([word]) => word);
}

export class LocalCompressionProvider implements CompressionProvider {
  private useLocalModel = process.env.COMPRESSION_PROVIDER === 'local';
  private modelPipeline: unknown | null = null;
  private loading: Promise<unknown> | null = null;

  constructor(private modelId: string = process.env.COMPRESSION_MODEL ?? 'Xenova/all-MiniLM-L6-v2') {}

  private async getPipeline(): Promise<unknown> {
    if (this.modelPipeline) return this.modelPipeline;
    if (this.loading) return this.loading;

    this.loading = pipeline('text2text-generation', this.modelId, { dtype: 'fp32' });
    this.modelPipeline = await this.loading;
    return this.modelPipeline;
  }

  private buildDeterministicSummary(task: TaskDescription, chunks: ContextChunk[]): CompressionResult {
    const sourceChunkIds = chunks.map((chunk) => chunk.id);
    const retainedConstraints = chunks
      .filter((chunk) => chunk.type === 'constraint')
      .map((chunk) => truncate(chunk.text.trim(), 220));
    const retainedFacts = chunks
      .filter((chunk) => chunk.type === 'fact' || chunk.type === 'background' || chunk.type === 'reference')
      .flatMap((chunk) => splitSentences(chunk.text).slice(0, 2).map((sentence) => truncate(sentence, 180)))
      .slice(0, 8);
    const codeSignatures = chunks
      .filter((chunk) => chunk.type === 'code')
      .flatMap((chunk) => extractCodeSignatures(chunk.text).map((signature) =>
        chunk.path ? `${chunk.path}: ${signature}` : signature
      ))
      .slice(0, 8);
    const keywords = extractKeywords(task, chunks);
    const sections = [
      `Task: ${truncate(task.text, 220)}`,
      keywords.length > 0 ? `Keywords: ${keywords.join(', ')}` : '',
      retainedConstraints.length > 0 ? `Constraints:\n- ${retainedConstraints.join('\n- ')}` : '',
      retainedFacts.length > 0 ? `Facts:\n- ${retainedFacts.join('\n- ')}` : '',
      codeSignatures.length > 0 ? `Code signatures:\n- ${codeSignatures.join('\n- ')}` : '',
      `Coverage: ${chunks.length} chunks, ${new Set(sourceChunkIds).size} unique sources`,
    ].filter(Boolean);

    return {
      summary: sections.join('\n\n'),
      retainedFacts,
      retainedConstraints,
      sourceChunkIds,
    };
  }

  async compress(task: TaskDescription, chunks: ContextChunk[]): Promise<CompressionResult> {
    const fallback = this.buildDeterministicSummary(task, chunks);
    if (!this.useLocalModel || chunks.length === 0) {
      return fallback;
    }

    try {
      const model = await this.getPipeline();
      const prompt = [
        'Summarize the following engineering context into constraints, facts, and code references.',
        `Task: ${task.text}`,
        fallback.summary,
      ].join('\n\n');
      const result = await (model as (input: string, options?: Record<string, unknown>) => Promise<unknown>)(
        prompt,
        { max_new_tokens: 180 }
      );
      const generatedText = Array.isArray(result)
        ? String((result[0] as { generated_text?: string }).generated_text ?? '')
        : '';
      if (!generatedText.trim()) {
        return fallback;
      }
      return {
        ...fallback,
        summary: `${generatedText.trim()}\n\n${fallback.summary}`,
      };
    } catch {
      return fallback;
    }
  }
}
