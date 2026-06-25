# Quality then publish — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bank two verified zero-risk wins, land the neural cross-encoder reranker behind the honesty gate, modernize the MCP surface, then publish Spacefolding v0.1.0 with sharpened positioning.

**Architecture:** Sequenced 4-phase plan — Q1 (verified quick wins) → Q2 (neural reranker, P5 reframed, ablation-gated) → Q3 (structuredContent/resource_link MCP surface, pre-D5) → Q4 (npm publish + positioning). Every retrieval/ranking change is validated by re-running the frozen blocking ablation gate; never claim a universal winner. Derived from the approved design: `docs/plans/2026-06-24-quality-then-publish-design.md`.

**Tech Stack:** TypeScript/Node (ESM), SQLite + sqlite-vec + FTS5, `@huggingface/transformers` (ONNX), vitest, `@modelcontextprotocol/sdk`. On branch `docs/quality-then-publish-design`; implement each phase on its own feature branch off `main`.

---

## Repo conventions (verified by the grounding pass — authoritative)

**Test runner:**

vitest ^4.1.9 (defined in package.json devDependencies; config in vitest.config.ts). Tests run via tsx/esm — no separate babel/jest config. `globals: true` is set so `describe/it/expect` are used unimported in some files, but existing tests (e.g. tests/model-cache.test.ts:1) import them explicitly from 'vitest' — follow the explicit-import style for new tests.

**Run all tests:**

npm test  (runs `vitest run`, all files matching tests/**/*.test.ts)

**Run one test file:**

npx vitest run tests/retriever-ranking.test.ts   (path is relative to repo root; vitest picks up vitest.config.ts automatically)

**Run one test case:**

npx vitest run tests/retriever-ranking.test.ts -t 'reports reranked final scores consistently with result ordering'   (the -t string is matched as a substring against the test name; quote it)

**Lint (type-check):**

npm run lint   (runs `tsc --noEmit`; there is NO eslint/style linter — type-checking IS the lint gate in CI: .github/workflows/ci.yml:23)

**Build:**

npm run build   (runs `tsc`; emits ESM to dist/; `"type": "module"`, all intra-package imports use the `.js` extension on relative paths, e.g. '../types/index.js')

**Test file convention:**

All tests live in /home/ben/Documents/Projects/spacefolding/tests/ (flat directory, NOT co-located with src). Naming: <topic>.test.ts. vitest.config.ts:6 `include: ['tests/**/*.test.ts']`. Example provider-adjacent test: tests/retriever-ranking.test.ts (instantiates HybridRetriever with a RerankerProvider at line 351). Model-cache test pattern (env save/restore in beforeEach/afterEach): tests/model-cache.test.ts. A tests/seed-data.ts helper exists for fixtures.

**Provider registration:**

Providers are NOT selected via a central registry; they are constructed imperatively from env vars in src/cli/index.ts and passed into the PipelineOrchestrator constructor. Embedding provider switch (src/cli/index.ts:165-213): `getEmbeddingProviderName()` reads `process.env.EMBEDDING_PROVIDER` → 'gpu' | 'deterministic' | (default)'local'; `createEmbeddingProviderConfig()` (l.183) constructs `new GpuEmbeddingProvider` | `new DeterministicEmbeddingProvider` | `new LocalEmbeddingProvider(model)`. Model id resolved by `getDefaultEmbeddingModel()` (l.171): gpu → `process.env.GPU_EMBEDDING_MODEL ?? 'Salesforce/SFR-Embedding-Code-400M_R'`; deterministic → 'deterministic'; local → `process.env.EMBEDDING_MODEL ?? 'Xenova/bge-small-en-v1.5'`. Compression uses the same pattern via `process.env.COMPRESSION_PROVIDER` ('deterministic'|'llm'|'local'|'llmlingua') at src/cli/index.ts:124-163. RERANKER IS CURRENTLY HARDCODED: `new DeterministicRerankerProvider()` is instantiated directly inside the PipelineOrchestrator constructor (src/pipeline/orchestrator.ts:36 import, l.92 instantiation) — there is NO env switch or RerankerProvider config yet. Adding a CrossEncoderRerankerProvider therefore requires BOTH: (a) a new provider class, and (b) a NEW selection switch (mirror the EMBEDDING_PROVIDER env pattern: e.g. RERANKER_PROVIDER='deterministic'|'cross-encoder', threaded from cli/index.ts createPipeline → PipelineOrchestrator ctor, replacing the hardcoded l.92). All providers are re-exported from the barrel src/providers/index.ts.

**Model-load pattern (transformers.js):**
```
transformers.js (@huggingface/transformers ^4.1.0) via the `pipeline()` factory, with a shared GLOBAL cache. Canonical pattern to mirror (src/providers/local-embedding.ts):
  1. import { pipeline, env } from '@huggingface/transformers';
  2. import { ensureModelCacheDir } from './model-cache.js';
  3. Configure cache ONCE at module top-level:
     env.allowLocalModels = true;
     env.localModelPath = ensureModelCacheDir();
     env.useBrowserCache = false;
  4. ensureModelCacheDir() (src/providers/model-cache.ts:31) resolves `${XDG_CACHE_HOME:-$HOME/.cache}/spacefolding/models`, honoring a `MODEL_PATH` override, and mkdirSync's it. So the ~100MB model downloads ONCE per machine and is reused across projects.
  5. Lazy-load with a memoized loading promise: class field `private pipe | null`, `private loading: Promise | null`; `getPipeline()` returns cached pipe or sets `this.loading = pipeline('feature-extraction', this.modelId, { dtype: 'fp32', progress_callback })` then `this.pipe = await this.loading`. (local-embedding.ts:21-40)
  6. For a CROSS-ENCER RERANKER the pipeline task is 'text-classification' (NOT 'feature-extraction') and pairs (query, document) as input; the class must implement RerankerProvider (src/types/index.ts:227-232): `rerank(query, documents): Promise<{index; score; reason}[]>`. Constructor takes a modelId default (mirror local-embedding.ts:19 `constructor(private modelId = 'Xenova/bge-small-en-v1.5')`, e.g. 'Xenova/bge-reranker-v2-m3'). The deterministic fallback (src/providers/deterministic-reranker.ts) is the offline/CI provider and must stay the default in CI (deterministic embeddings are what make the blocking gate exact/non-flaky — see ci.yml:62-97). sibling local-compression.ts:7-13,67 shows the identical env+pipeline+dtype:'fp32' pattern for a non-feature-extraction task ('text2text-generation').
```

**FROZEN BLOCKING ablation gate (honesty rule):**
```
FROZEN BLOCKING non-regression gate (regime-robust, runs on deterministic provider, exact-match because deterministic embeddings are non-flaky). This is THE gate the design's 'honesty rule' refers to — re-run before/after ANY retrieval/ranking change. Two-step (must run from repo root after `npm run build`):

STEP 1 (produce eval.json — uses frozen self-corpus + deterministic depth to match the pinned baseline exactly):
  BENCHMARK_RETRIEVAL_DEPTH=200 npx tsx benchmarks/evaluate.ts --corpus-snapshot benchmarks/fixtures/self-corpus.json --strategy all --json > eval.json

STEP 2 (the blocking verdict; exits 1 on regression):
  npx tsx benchmarks/check-acceptance.ts --blocking-subset --retrieval-json eval.json

Pinned baseline: benchmarks/baselines/deterministic-baseline.json. Frozen corpus: benchmarks/fixtures/self-corpus.json (re-freeze only deliberately via benchmarks/freeze-self-corpus.ts). Gate logic in benchmarks/check-acceptance.ts: BLOCKING_REGRESSION_STRATEGIES=['structural','fts','bm25','keyword'] (l.255), BLOCKING_REGRESSION_METRICS=['recallAt10','hitsAt1'] (l.256); non-regression vs baseline−margin; prints 'Acceptance gate: PASS|FAIL' (l.599) and process.exit(1) on fail (l.634). Spec/rationale: docs/decisions/adr-001-regime-robust-blocking-gate.md. NOTE: the SYMBOL-REMOVED ablation (--symbol-removed flag on evaluate.ts:512, l.1800; re-runs every strategy on task_symbol_removed) is the durability check for the exact-identifier top-1 edge but is NOT wired into the CI blocking job — run it manually when the design says 'deterministic non-regression + the symbol-removed ablation'. The composite superiority gate (full check-acceptance with --retrieval-json + --e2e-json) is INFORMATIONAL only (ci.yml:39 continue-on-error:true) and FAILS on the deterministic provider — never use it as a blocking claim.
```

**Branch convention:**

Feature/topic branches off main, lowercase-hyphenated, often prefixed by a short phase/workstream slug. Verified existing branches: main, docs/quality-then-publish-design (current), next-phases-wave-a, phase0-credibility-fixes, ws03-ranking-cleanup (the in-flight ranking branch the design says to fold into, NOT redo). Commits use Conventional-Commits style: `docs(plans): ...`, `feat(...)/fix(...)/D3/S4:` prefixes observed in `git log --oneline`. PRs only on explicit user request.

---

## Phase Q1a — cache-aware Context Pack (stable prefix, volatile trailer)

**Grounding (real-code facts this phase rests on):**

- `src/core/context-pack.ts`:4-28 — ContextPackInput type — the exact fields. Volatile-per-query fields the pack currently leads with: query (l.5), plan.intent/strategy/maxHops (l.16-20), totalTokens/targetBudget/hardBudget/utilization (l.8-12), selectionPolicy.selectedCandidates/droppedCandidates (l.23-27), retrieval[] (l.21, carries sourceScores + reasons), omitted (l.13), dropped (l.14). chunks[] (l.6) + tiers (l.7) are the stable content.
- `src/core/context-pack.ts`:30-56 — formatContextPack currently emits a VOLATILE header before the stable instructions: l.34 title (stable), l.36 'Query: <query>' (volatile), l.37-39 Intent|Strategy|Mode (volatile), l.40-42 Graph hops (volatile/optional), l.43-45 Tokens/utilization (volatile), l.46 Candidates counts (volatile), l.48-53 '## How To Use This Pack' instructions (STABLE), l.54 '## Selected Context' (stable). This interleaving is why prompt caching misses every call.
- `src/core/context-pack.ts`:62-85 — Per-chunk body embeds volatile retrieval metadata inline: l.76 'Sources: ...', l.77 'Scores: <formatScores>' (volatile across queries), l.78 'Why: <reasons>' (volatile). The fenced code block (l.81-84 ~~~lang/text/~~~) and title/type/tokens (l.69-74) are STABLE for a given chunk. For a byte-identical stable prefix across inputs sharing chunks but differing in scores, Sources/Scores/Why must move to the trailer.
- `src/core/context-pack.ts`:87-112 — Trailing sections Omitted By Budget (l.87-97) and Dropped Candidate Diagnostics (l.99-109) are already volatile and trailing. Return is lines.join('\n').trimEnd()+'\n' (l.111) — single trailing newline; new sections must preserve this exact termination.
- `src/core/context-pack.ts`:140-161 — Helpers formatScores, formatPercent, oneLine, safeInlineCode are pure and reused. formatScores (l.140-149) emits 'final=.. structural=.. fts=.. vector=.. graph=.. dependency=..' — must keep emitting identical strings in the new trailer so the existing 'Scores: final=12.000 structural=10.000' toContain assertion still passes.
- `tests/context-pack.test.ts`:57-71 — Existing pack test uses ONLY expect(pack).toContain(substring) for every assertion: title, 'Query: where is targetContextPack', 'Intent: explain | Strategy: structural | Mode: focused', 'Tokens: 42/500 target (1000 hard cap, 4%)', '### 1. src/context-pack.ts [warm]', 'Sources: structural+fts', 'Scores: final=12.000 structural=10.000', 'Why: symbol match: targetContextPack', '~~~typescript', '## Omitted By Budget', '## Dropped Candidate Diagnostics'. NONE are positional — all will pass after reorder as long as substrings are preserved.
- `tests/interface.test.ts`:311-314 — CLI pack consumer assertion: output must still contain '# Spacefolding Context Pack', 'Query: where is cliContextPackTarget', 'pack-target.ts', 'export function cliContextPackTarget()'. All substring; reorder-safe.
- `tests/interface.test.ts`:587-590 — MCP pack consumer assertion (retrieve_context format=pack): pack must still contain '# Spacefolding Context Pack', 'Query: where is mcpContextPackTarget', 'src/mcp/context-pack.ts', 'export function mcpContextPackTarget()'. All substring; reorder-safe.
- `src/mcp/server.ts`:681-683 — MCP caller returns formatContextPack output verbatim via textResponse — no parsing. Confirms no positional downstream coupling.
- `src/cli/index.ts`:491-495 — CLI caller console.log(formatContextPack(...)) verbatim — no parsing. Confirms no positional downstream coupling.
- `docs/plans/2026-06-24-quality-then-publish-design.md`:33-38 — Q1a spec: freeze a stable prefix (instructions/static reference), move volatile data (query string, scores, utilization, candidate counts) to a trailing section. Test = stable prefix byte-identical across same-chunks/different-query inputs; existing pack tests stay green. Gate: NONE (pure serialization reorder) — ablation gate explicitly NOT required for this phase.

### Task Q1a.1: Write failing test: stable prefix is byte-identical across two inputs that share chunks but differ in query/scores/utilization

**Files:** Test: tests/context-pack.test.ts (append a new it() inside the existing describe('formatContextPack', ...) block, after the test at l.21-72). No other files touched in this step.

**Step 1 (write-failing-test):** Append a second test to the existing describe block. It builds two ContextPackInputs that share the SAME chunks/tiers (the stable content) but differ in every volatile field (query, plan intent/strategy, utilization, totalTokens, candidate counts, retrieval sourceScores + reasons, omitted, dropped). It computes each pack's stable prefix = everything up to the first occurrence of the trailer delimiter line '## Query Metadata' and asserts the two prefixes are byte-identical (===). It also asserts both packs still contain the volatile values somewhere after the delimiter (so the test does not pass by accident via a missing trailer).
```ts
import { describe, expect, it } from 'vitest';
import { formatContextPack } from '../src/core/context-pack.js';
import type { ContextChunk } from '../src/types/index.js';

function makeChunk(overrides: Partial<ContextChunk> = {}): ContextChunk {
  return {
    id: 'chunk-1',
    source: 'file',
    type: 'code',
    text: 'export function targetContextPack() { return true; }',
    timestamp: 1,
    path: 'src/context-pack.ts',
    language: 'typescript',
    tokensEstimate: 42,
    childrenIds: [],
    metadata: {},
    ...overrides,
  };
}

describe('formatContextPack', () => {
  it('formats selected chunks, retrieval reasons, budget metadata, and diagnostics', () => {
    // ... existing test unchanged ...
  });

  it('keeps a byte-identical stable prefix across inputs that share chunks but differ in query/scores/utilization (cache-aware)', () => {
    const sharedChunks = [makeChunk()];
    const sharedTiers = new Map([['chunk-1', 'warm']]);

    const baseInput = {
      chunks: sharedChunks,
      tiers: sharedTiers,
      budget: 1000,
      hardBudget: 1000,
      targetBudget: 500,
    };

    const packA = formatContextPack({
      ...baseInput,
      query: 'where is targetContextPack',
      totalTokens: 42,
      utilization: 0.042,
      omitted: [{ chunkId: 'chunk-2', tokensEstimate: 900, reason: 'exceeds remaining budget' }],
      dropped: [{ chunkId: 'chunk-3', reason: 'below focused score threshold' }],
      plan: { intent: 'explain', strategy: 'structural', maxHops: 0 },
      retrieval: [{
        chunkId: 'chunk-1',
        score: 12,
        sources: ['structural', 'fts'],
        reasons: ['symbol match: targetContextPack', 'scores final=12.000'],
        sourceScores: { structural: 10, fts: 2, vector: 0, graph: 0, dependency: 0, final: 12 },
      }],
      selectionPolicy: { mode: 'focused', effectiveBudget: 500, selectedCandidates: 1, droppedCandidates: 1 },
    });

    const packB = formatContextPack({
      ...baseInput,
      query: 'a completely different query string',
      totalTokens: 999,
      utilization: 0.876,
      omitted: [{ chunkId: 'chunk-9', tokensEstimate: 7, reason: 'a different omission reason' }],
      dropped: [{ chunkId: 'chunk-8', reason: 'a different drop reason' }],
      plan: { intent: 'locate', strategy: 'text', maxHops: 3 },
      retrieval: [{
        chunkId: 'chunk-1',
        score: 99,
        sources: ['vector'],
        reasons: ['semantic match'],
        sourceScores: { structural: 0, fts: 0, vector: 88, graph: 0, dependency: 0, final: 99 },
      }],
      selectionPolicy: { mode: 'broad', effectiveBudget: 500, selectedCandidates: 5, droppedCandidates: 9 },
    });

    const delimiter = '## Query Metadata';
    const prefixA = packA.slice(0, packA.indexOf(delimiter));
    const prefixB = packB.slice(0, packB.indexOf(delimiter));

    // The whole point of Q1a: a prompt-cacheable, byte-identical stable prefix.
    expect(prefixA).toBe(prefixB);

    // Guard: the prefix must actually contain the stable instructional content
    // (so the test cannot pass by emitting an empty prefix).
    expect(prefixA).toContain('# Spacefolding Context Pack');
    expect(prefixA).toContain('## How To Use This Pack');
    expect(prefixA).toContain('## Selected Context');
    expect(prefixA).toContain('### 1. src/context-pack.ts [warm]');
    expect(prefixA).toContain('export function targetContextPack()');

    // Guard: volatile values must still exist, but only in the trailer.
    const trailerA = packA.slice(packA.indexOf(delimiter));
    const trailerB = packB.slice(packB.indexOf(delimiter));
    expect(trailerA).toContain('Query: where is targetContextPack');
    expect(trailerA).toContain('Tokens: 42/500 target (1000 hard cap, 4% used)');
    expect(trailerA).toContain('Candidates: 1 selected, 1 dropped');
    expect(trailerA).toContain('Scores: final=12.000');
    expect(trailerB).toContain('Query: a completely different query string');
    expect(trailerB).toContain('Tokens: 999/500 target (1000 hard cap, 88% used)');
    expect(trailerB).toContain('Candidates: 5 selected, 9 dropped');
    expect(trailerB).toContain('Scores: final=99.000');
  });
});
```
```bash
npx vitest run tests/context-pack.test.ts -t 'byte-identical stable prefix'
```
Expected: FAIL. Specific failure: the current formatContextPack emits 'Query:' (src/core/context-pack.ts:36) BEFORE '## How To Use This Pack' (l.48) and embeds 'Scores:' inline in the chunk body (l.77). packA.indexOf('## Query Metadata') === -1, so prefixA = the entire packA, prefixB = entire packB, and prefixA !== prefixB. Vitest reports expected '' to equal '' OR a substring assertion failing — concretely the .toBe(prefixB) assertion fails with a diff showing the divergent 'Query:' / 'Tokens:' / 'Scores:' lines, OR the '## Query Metadata' / trailer substring assertions fail because the delimiter does not yet exist. Either way: 1 test failed.

**Step 2 (commit):** Commit the failing test in the canonical TDD red step. (If repo convention is to only commit green, this commit may be squashed into step 4 — but the plan follows strict TDD red/green cadence, so commit red here.)
```bash
git add tests/context-pack.test.ts && git commit -m 'test(context-pack): byte-identical stable prefix across volatile query/scores/utilization (RED)'
```
Expected: 1 file changed; commit created on docs/quality-then-publish-design.

**Commit:** `test(context-pack): byte-identical stable prefix across volatile query/scores/utilization (RED)`

**Risks:** Low. Test is pure-string, no DB/model, ~200ms. Risk: picking a delimiter string '## Query Metadata' that collides with chunk text — mitigated by guards (chunk text in this test is 'export function targetContextPack()...', no collision) and the delimiter is a markdown heading never emitted today. If the implementer later renames the section heading, the test's `delimiter` constant must be updated in lockstep (called out in task 2).

---

### Task Q1a.2: Implement the reorder: stable prefix first, volatile Query Metadata + Per-Chunk Scores trailer — no information content changed

**Files:** Modify: src/core/context-pack.ts:30-112 (rewrite the body of formatContextPack; keep the ContextPackInput type l.4-28 and all helpers l.114-161 unchanged). Add ONE new section-heading constant used by both implementation and test (see risks).

**Step 1 (implement):** Rewrite formatContextPack so the emitted line order is: (A) STABLE PREFIX — title, the full '## How To Use This Pack' instruction block (3 bullets, unchanged text), '## Selected Context', the per-chunk bodies INCLUDING title/Chunk id/Original chunk/Type/Tokens/fenced ~~~ code block, but EXCLUDING the per-chunk Sources/Scores/Why lines. (B) VOLATILE TRAILER — a new '## Query Metadata' section containing: Query, Intent|Strategy|Mode, Graph hops (optional), Tokens/utilization, Candidates counts (the former header block, verbatim text); then a new '## Per-Chunk Retrieval' section mapping each chunk index+title to its Sources/Scores/Why lines (verbatim, preserving formatScores output); then the existing '## Omitted By Budget' and '## Dropped Candidate Diagnostics' sections unchanged. The stable prefix ends exactly at the byte before '## Query Metadata'. Same chunks => identical prefix regardless of query/scores/utilization/counts/omitted/dropped.
```ts
// === Replace the entire body of formatContextPack (src/core/context-pack.ts:30-112) ===

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
```
```bash
npx vitest run tests/context-pack.test.ts
```
Expected: PASS — both the pre-existing 'formats selected chunks...' test AND the new 'byte-identical stable prefix' test pass (2 passed). The existing test passes because every assertion is a substring (toContain) and all substrings are still emitted verbatim (Query/Intent/Tokens/Sources/Scores/Why/Omitted/Dropped moved, not removed).

**Step 2 (verify-gate):** Confirm no downstream test regressed. The two interface.test.ts consumers (CLI at l.311-314, MCP at l.587-590) use only substring assertions on title/Query/path/export-line — all preserved. Run the full suite.
```bash
npx vitest run
```
Expected: All previously-green tests still green (~503 tests per design doc). If any interface test breaks, it would be a substring that was silently order-dependent — but none are (verified: all toContain).

**Step 3 (verify-gate):** Type-check (lintCmd) — the rewrite reuses existing helpers and the unchanged ContextPackInput type, so tsc --noEmit must be clean.
```bash
npx tsc --noEmit
```
Expected: No output, exit 0.

**Step 4 (run-pass):** Final confirmation the new test is green in isolation (fast feedback loop for the reviewer).
```bash
npx vitest run tests/context-pack.test.ts -t 'byte-identical stable prefix'
```
Expected: 1 passed.

**Step 5 (commit):** Commit the implementation on top of the RED commit. Squash-or-keep is the owner's call; this plan keeps RED + GREEN as two commits per strict TDD cadence.
```bash
git add src/core/context-pack.ts && git commit -m 'refactor(context-pack): cache-aware stable prefix + volatile Query Metadata/Per-Chunk Retrieval trailer (GREEN)
```
Expected: 1 file changed (src/core/context-pack.ts); commit created. Phase Q1a complete.

**Commit:** `refactor(context-pack): cache-aware stable prefix + volatile Query Metadata/Per-Chunk Retrieval trailer (GREEN)`

**Risks:** MEDIUM — this is the load-bearing step. (1) Information-content fidelity: the ONLY allowed change is line ORDER/location; every substring the existing tests assert must still appear. Verified all 14 assertions in tests/context-pack.test.ts:57-70 are toContain-substring and every emitted string (Query:, Intent:, Tokens:, Candidates:, Sources:, Scores: via unchanged formatScores, Why:, Omitted, Dropped) is preserved verbatim in the new trailer. (2) Byte-identity of the prefix requires the per-chunk Sources/Scores/Why lines to leave the chunk body — confirmed they are volatile (sourceScores/reasons differ per query). If a future change re-inlines them, the cache property silently breaks; the new test is the regression guard. (3) The delimiter constant '## Query Metadata' is duplicated as a string literal between test and impl — if renamed in one place only the test breaks loudly (acceptable; prefer exporting QUERY_METADATA_HEADING later if the team wants, but that widens the diff). (4) Empty-chunks case: the 'No chunks selected...' line stays in the stable prefix — two empty-pack calls with different queries still share a prefix (correct). (5) The blocking ablation gate is NOT required (design: Gate none); optionally re-run npx tsx benchmarks/check-acceptance.ts --blocking-subset --retrieval-json eval.json as extra reassurance, but it is not a pass criterion for this phase.

---

## Phase Q1b — batched vec0 inserts + kill per-call COUNT(*)

**Grounding (real-code facts this phase rests on):**

- `src/storage/vector-index.ts`:166-179 — add() does a per-row INSERT OR REPLACE into the vec0 table (174-177) then this.count = this.loadCount() (178) on EVERY call — the literal 60k ingestion-bound tax.
- `src/storage/vector-index.ts`:142-147 — loadCount() runs `SELECT COUNT(*) as cnt FROM ${VEC_TABLE}` via prepare().get() — a full vec0 scan, invoked once per add() and once per remove().
- `src/storage/vector-index.ts`:149-164 — loadFromDb() already batches all inserts in ONE db.transaction(() => {...}) (157-162) — the exact pattern addMany must mirror — but still ends with this.count = this.loadCount() (163).
- `src/storage/vector-index.ts`:57-89 — VEC_META_TABLE = 'spacefolding_vec_meta' (key TEXT PRIMARY KEY, value TEXT) already exists (89) and is used for 'dimension' and 'rebuildCount' (110-111, 136-140) via readMeta/writeMeta — the natural home for a mirrored 'count' key.
- `src/storage/vector-index.ts`:23-29 — VectorIndex interface declares add(chunkId, embedding):void; remove; search; size; dimensions. addMany must be added here and implemented by BOTH SqliteVecIndex and BruteForceVectorIndex (the fallback at 227).
- `src/storage/vector-index.ts`:181-186 — remove() also calls this.loadCount() (185) after the DELETE — same COUNT(*) tax; the count mirror must stay correct on remove too.
- `src/storage/repository.ts`:584-599 — storeEmbedding(chunkId, embedding, model) (584) is the single ingestion entry: writes chunk_embeddings (586-591), re-inits on dim mismatch (592-594), else calls this.vectorIndex.add(chunkId, embedding) (596-597) ONE AT A TIME. This is what the watcher/incremental path funnels through.
- `src/pipeline/orchestrator.ts`:672-686 — storeChunkWithEmbedding(chunk) (672) awaits embeddingProvider.embed(chunk.text) (677) then calls storage.storeEmbedding(chunk.id, embedding, model) (682) per chunk. storeIncomingChunks (688-727) loops non-split chunks calling storeChunkWithEmbedding sequentially (707-709) — the batching point.
- `src/pipeline/orchestrator.ts`:688-727 — storeIncomingChunks(chunks) already iterates chunks in two phases (split parents 698-705, then embeddable 707-713). Phase 2 is where embeddings are produced sequentially and could be collected into a single addMany batch.
- `.github/workflows/ci.yml`:86-91 — The BLOCKING gate is a benchmark job: BENCHMARK_RETRIEVAL_DEPTH=200 npx tsx benchmarks/evaluate.ts --corpus-snapshot benchmarks/fixtures/self-corpus.json --strategy all --json > eval.json ; then npx tsx benchmarks/check-acceptance.ts --blocking-subset --retrieval-json eval.json. It is NOT run by npm test.
- `node_modules/@types/better-sqlite3/index.d.ts`:1-146 — better-sqlite3 types do NOT expose db.trace(); prepare/exec/pragma are the only instrumentable proto methods (verified at runtime: Object.getPrototypeOf(db) has only prepare/pragma/exec). SQL-statement spying must wrap db.prepare.
- `tests/vector-index.test.ts`:41-153 — Existing vector tests go through createRepository(path) + initVectorIndex(dim) + storeEmbedding, never construct SqliteVecIndex directly. sqlite-vec DOES load in this env (verified), so a unit test can call tryCreateSqliteVecIndex(db, dim) directly and spy on db.prepare.

### Task Q1b.1: Add addMany to VectorIndex interface + BruteForceVectorIndex (failing test first)

**Files:** Test: tests/vector-index.test.ts (new describe block). Modify: src/storage/vector-index.ts:23-29 (interface), src/storage/vector-index.ts:227-278 (BruteForceVectorIndex)

**Step 1 (write-failing-test):** Append a new describe('VectorIndex.addMany interface') to tests/vector-index.test.ts. Test that a BruteForceVectorIndex (constructable without sqlite-vec) supports addMany(items), keeps size() correct, returns expected search order, and that single add() still works alongside it. BruteForceVectorIndex isolates the interface contract from the sqlite-vec extension.
```ts
import { BruteForceVectorIndex } from '../src/storage/vector-index.js';

describe('VectorIndex.addMany interface', () => {
  it('BruteForceVectorIndex.addMany inserts all items and keeps size() correct', () => {
    const idx = new BruteForceVectorIndex(2);
    const items = [
      { chunkId: 'a', embedding: [1, 0] },
      { chunkId: 'b', embedding: [0, 1] },
      { chunkId: 'c', embedding: [1, 1] },
    ];
    idx.addMany(items);
    expect(idx.size()).toBe(3);
    expect(idx.search([0, 1], 3).map((r) => r.chunkId)).toEqual(['b', 'c', 'a']);
    idx.add('d', [0, 0]);
    expect(idx.size()).toBe(4);
  });
});
```

**Step 2 (run-fail):** Run only the new interface test to confirm it fails for the right reason (method missing), not for an unrelated setup error.
```bash
npx vitest run tests/vector-index.test.ts -t 'addMany interface'
```
Expected: FAIL — TypeError: idx.addMany is not a function (BruteForceVectorIndex has no addMany yet, and VectorIndex interface lacks it). Confirms RED.

**Step 3 (implement):** Add addMany to the VectorIndex interface (after add, line 24) and implement it on BruteForceVectorIndex (after its add() at line 239) by delegating to add() in a loop — the in-memory map has no batch concept.
```ts
// interface (after line 24):
  addMany(items: Array<{ chunkId: string; embedding: number[] }>): void;

// BruteForceVectorIndex (insert after the add() method body, before remove()):
  addMany(items: Array<{ chunkId: string; embedding: number[] }>): void {
    for (const { chunkId, embedding } of items) {
      this.add(chunkId, embedding);
    }
  }
```

**Step 4 (run-pass):** Re-run the new interface test to confirm it passes after the minimal implementation.
```bash
npx vitest run tests/vector-index.test.ts -t 'addMany interface'
```
Expected: PASS (1 test). BruteForceVectorIndex.addMany works; interface typed.

**Step 5 (verify-gate):** Run the repo type-check to ensure the interface addition is consistent across all implementors referenced so far.
```bash
npm run lint
```
Expected: PASS — tsc --noEmit clean.

**Step 6 (commit):** Commit the interface + BruteForceVectorIndex change with the exact message.

**Commit:** `Q1b: add addMany to VectorIndex interface + BruteForceVectorIndex`

**Risks:** Trivial, in-memory. Confirm interface addition does not break other VectorIndex implementors — grep shows only SqliteVecIndex and BruteForceVectorIndex implement it (task 2 covers SqliteVecIndex).

---

### Task Q1b.2: SqliteVecIndex.addMany: 1 transaction + 0 COUNT(*) scans (failing spy test first)

**Files:** Test: tests/vector-index.test.ts (new describe block). Modify: src/storage/vector-index.ts:59-219 (SqliteVecIndex: addMany, refactor add/remove/loadFromDb/constructor to mirror count in VEC_META_TABLE)

**Step 1 (write-failing-test):** Append describe('SqliteVecIndex.addMany batched inserts'). Build the index with tryCreateSqliteVecIndex(db, 2) directly (sqlite-vec verified to load in this env). Wrap db.prepare AFTER construction to count statements containing COUNT(*). Assert addMany of 3 items issues ZERO COUNT(*) scans, size()==3, and search returns correct order. Add a second test counting BEGIN statements via db.exec to assert a single transaction.
```ts
import { tryCreateSqliteVecIndex } from '../src/storage/vector-index.js';
import Database from 'better-sqlite3';

describe('SqliteVecIndex.addMany batched inserts', () => {
  it('addMany of N items issues zero COUNT(*) scans and keeps size() correct', () => {
    const db = new Database(':memory:');
    const index = tryCreateSqliteVecIndex(db, 2);
    expect(index).not.toBeNull();

    const counts = { countStar: 0 };
    const realPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (/COUNT\(\*\)/i.test(sql)) counts.countStar += 1;
      return realPrepare(sql);
    }) as typeof db.prepare;

    const items = [
      { chunkId: 'a', embedding: [1, 0] },
      { chunkId: 'b', embedding: [0, 1] },
      { chunkId: 'c', embedding: [1, 1] },
    ];
    index!.addMany(items);

    expect(counts.countStar).toBe(0);
    expect(index!.size()).toBe(3);
    expect(index!.search([0, 1], 3).map((r) => r.chunkId)).toEqual(['b', 'c', 'a']);
    db.close();
  });

  it('addMany runs all inserts inside a single transaction', () => {
    const db = new Database(':memory:');
    const index = tryCreateSqliteVecIndex(db, 2);
    expect(index).not.toBeNull();
    const tx = { begins: 0 };
    const realExec = db.exec.bind(db);
    db.exec = ((sql: string) => {
      if (/^\s*BEGIN/i.test(sql)) tx.begins += 1;
      return realExec(sql);
    }) as typeof db.exec;
    index!.addMany([
      { chunkId: 'a', embedding: [1, 0] },
      { chunkId: 'b', embedding: [0, 1] },
      { chunkId: 'c', embedding: [1, 1] },
    ]);
    expect(tx.begins).toBe(1);
    expect(index!.size()).toBe(3);
    db.close();
  });
});
```

**Step 2 (run-fail):** Run the new batched-insert tests to confirm they fail because SqliteVecIndex.addMany does not exist.
```bash
npx vitest run tests/vector-index.test.ts -t 'SqliteVecIndex.addMany'
```
Expected: FAIL — TypeError: index.addMany is not a function (SqliteVecIndex has no addMany yet). Confirms RED.

**Step 3 (implement):** Add a mirrored 'count' meta key. Add setCount() that writes the mirror. Refactor add()/remove() to use existence checks (SELECT 1) and DELETE .changes instead of loadCount(). Refactor loadFromDb() to setCount(rows.length). Refactor the constructor reused-index branch to read the mirror (fallback to loadCount() once on first upgrade). Implement addMany as ONE transaction with existence checks, mirroring count.
```ts
// near other consts (after line 57):
const COUNT_META_KEY = 'count';

// inside SqliteVecIndex — new private helper:
  private setCount(n: number): void {
    this.count = n;
    this.writeMeta(COUNT_META_KEY, String(n));
  }

// add() — replace `this.count = this.loadCount();` (line 178):
  add(chunkId: string, embedding: number[]): void {
    if (embedding.length !== this.dimensionCount) {
      throw new Error(
        `Embedding dimensions ${embedding.length} do not match vector index dimensions ${this.dimensionCount}`
      );
    }
    const existed = this.db
      .prepare(`SELECT 1 AS ok FROM ${VEC_TABLE} WHERE chunkId = ?`)
      .get(chunkId) as { ok: number } | undefined;
    const buf = new Float32Array(embedding);
    this.db
      .prepare(`INSERT OR REPLACE INTO ${VEC_TABLE}(chunkId, embedding) VALUES (?, ?)`)
      .run(chunkId, Buffer.from(buf.buffer));
    this.setCount(this.count + (existed ? 0 : 1));
  }

// remove() — replace `this.count = this.loadCount();` (line 185):
  remove(chunkId: string): void {
    const info = this.db
      .prepare(`DELETE FROM ${VEC_TABLE} WHERE chunkId = ?`)
      .run(chunkId);
    this.setCount(Math.max(0, this.count - info.changes));
  }

// addMany — ONE transaction, mirror count, NO COUNT(*) scan:
  addMany(items: Array<{ chunkId: string; embedding: number[] }>): void {
    if (items.length === 0) return;
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO ${VEC_TABLE}(chunkId, embedding) VALUES (?, ?)`
    );
    const exists = this.db.prepare(
      `SELECT 1 AS ok FROM ${VEC_TABLE} WHERE chunkId = ?`
    );
    let added = 0;
    const tx = this.db.transaction(() => {
      for (const { chunkId, embedding } of items) {
        if (embedding.length !== this.dimensionCount) {
          throw new Error(
            `Embedding dimensions ${embedding.length} do not match vector index dimensions ${this.dimensionCount}`
          );
        }
        const existed = exists.get(chunkId) as { ok: number } | undefined;
        const buf = new Float32Array(embedding);
        insert.run(chunkId, Buffer.from(buf.buffer));
        if (!existed) added += 1;
      }
    });
    tx();
    this.setCount(this.count + added);
  }

// loadFromDb() — keep the transactional batch (157-162); replace final
// `this.count = this.loadCount();` (line 163) with:
    this.setCount(rows.length);

// constructor reused-index branch (line 77) `this.count = this.loadCount();`
// — replace with mirror read + one-time fallback for old DBs:
    const mirrored = this.readMeta(COUNT_META_KEY);
    this.count = mirrored !== null ? Number(mirrored) : this.loadCount();
    if (mirrored === null) this.setCount(this.count);
```

**Step 4 (run-pass):** Run the full vector-index test file to confirm both new addMany tests pass and the 6 existing tests (hydration, dimension change, delete, rebuild-on-reopen) still pass after the count-mirror refactor.
```bash
npx vitest run tests/vector-index.test.ts
```
Expected: PASS — all 8 tests (6 existing + 2 new). addMany tests: 0 COUNT(*) scans, 1 transaction.

**Step 5 (write-failing-test):** Add a guard test proving the COUNT(*) tax is also gone from the single-item hot path add(), not just addMany. Spy on db.prepare for COUNT(*) and call add() twice.
```ts
it('add() (single) issues zero COUNT(*) scans after refactor', () => {
    const db = new Database(':memory:');
    const index = tryCreateSqliteVecIndex(db, 2)!;
    const counts = { countStar: 0 };
    const realPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (/COUNT\(\*\)/i.test(sql)) counts.countStar += 1;
      return realPrepare(sql);
    }) as typeof db.prepare;
    index.add('a', [1, 0]);
    index.add('b', [0, 1]);
    expect(counts.countStar).toBe(0);
    expect(index.size()).toBe(2);
    db.close();
  });
```

**Step 6 (run-pass):** Run the single-add spy test to confirm the refactor removed COUNT(*) from add() too.
```bash
npx vitest run tests/vector-index.test.ts -t 'add() (single) issues zero'
```
Expected: PASS — confirms the COUNT(*) tax is removed from add() as well.

**Step 7 (verify-gate):** Type-check the whole repo after the SqliteVecIndex refactor.
```bash
npm run lint
```
Expected: PASS — tsc --noEmit clean.

**Step 8 (commit):** Commit the SqliteVecIndex addMany + count-mirror refactor with the exact message.

**Commit:** `Q1b: SqliteVecIndex.addMany batches inserts in one tx, mirrors count in metadata (kill per-call COUNT(*))`

**Risks:** The constructor reused-index branch now trusts the mirrored 'count' key on reopen. If an old DB predates the key, the fallback reads loadCount() once and seeds the mirror — safe. add()/remove()/addMany keep count exact via existence checks (SELECT 1, not COUNT(*)) and DELETE .changes. The dimension-mismatch throw inside addMany's transaction rolls back the whole batch (better-sqlite3 transaction throws abort it) — acceptable and matches loadFromDb's all-or-nothing semantics. MUST re-run full npm test + the blocking acceptance benchmark in task 4 since this touches the count contract.

---

### Task Q1b.3: Wire storeEmbeddingsMany through repository + route orchestrator ingestion through addMany

**Files:** Modify: src/storage/repository.ts:584-606 (add storeEmbeddingsMany near storeEmbedding), src/pipeline/orchestrator.ts:688-727 (storeIncomingChunks phase 2). Test: tests/vector-index.test.ts (repository-level batch case)

**Step 1 (write-failing-test):** Add a repository-level test in tests/vector-index.test.ts: store 3 chunks, call repo.storeEmbeddingsMany(items, model), assert correct search order and that single storeEmbedding still works alongside it. COUNT(*) accounting is covered by task 2's direct index tests; this test covers the repository wiring contract.
```ts
it('storeEmbeddingsMany batches embeddings into the vector index', () => {
    const repo = createRepository(testDbPath());
    storeTestChunk(repo, 'a'); storeTestChunk(repo, 'b'); storeTestChunk(repo, 'c');
    repo.initVectorIndex(2);
    repo.storeEmbeddingsMany(
      [
        { chunkId: 'a', embedding: [1, 0] },
        { chunkId: 'b', embedding: [0, 1] },
        { chunkId: 'c', embedding: [1, 1] },
      ],
      'test-2d',
    );
    expect(repo.searchByVector([0, 1], 3).map((r) => r.chunkId)).toEqual(['b', 'c', 'a']);
    storeTestChunk(repo, 'd');
    repo.storeEmbedding('d', [0, 0], 'test-2d');
    expect(repo.searchByVector([0, 0], 4).map((r) => r.chunkId)).toContain('d');
    repo.close();
  });
```

**Step 2 (run-fail):** Run the new storeEmbeddingsMany test to confirm it fails because the repository method does not exist.
```bash
npx vitest run tests/vector-index.test.ts -t 'storeEmbeddingsMany'
```
Expected: FAIL — TypeError: repo.storeEmbeddingsMany is not a function. Confirms RED.

**Step 3 (implement):** In src/storage/repository.ts add storeEmbeddingsMany(items, model) near storeEmbedding (line 584). Write all chunk_embeddings rows in one transaction and call vectorIndex.addMany once. Mirror storeEmbedding's dimension-reinit guard for the whole batch.
```ts
storeEmbeddingsMany(
    items: Array<{ chunkId: string; embedding: number[] }>,
    model: string,
  ): void {
    if (items.length === 0) return;
    const dim = items[0].embedding.length;
    if (this.vectorIndex && this.vectorIndex.dimensions() !== dim) {
      this.initVectorIndex(dim);
    }
    const insertEmb = this.db.prepare(
      `INSERT OR REPLACE INTO chunk_embeddings (chunkId, embedding, model, dimensions, timestamp)
       VALUES (?, ?, ?, ?, ?)`
    );
    const insertManyEmb = this.db.transaction((rows: Array<[string, Buffer, string, number, number]>) => {
      for (const r of rows) insertEmb.run(...r);
    });
    const now = Date.now();
    insertManyEmb(
      items.map((it) => [
        it.chunkId,
        Buffer.from(new Float32Array(it.embedding).buffer),
        model,
        it.embedding.length,
        now,
      ]),
    );
    if (this.vectorIndex) {
      this.vectorIndex.addMany(items);
    }
  }
```

**Step 4 (implement):** Refactor orchestrator.storeIncomingChunks phase 2 (src/pipeline/orchestrator.ts:707-713) to collect (chunkId, embedding) into a batch and flush once via storage.storeEmbeddingsMany. Keep storeChunk + storeChunkStructure per chunk. Produce embeddings sequentially (embed() awaited per chunk) but accumulate and call storeEmbeddingsMany once at the end of phase 2.
```ts
// Replace the phase-2 loop body (lines 707-713) with:
    const batch: Array<{ chunkId: string; embedding: number[] }> = [];
    for (const chunk of chunks) {
      if (chunk.metadata?.split) continue;
      this.storage.storeChunk(chunk);
      await this.storeChunkStructure(chunk);
      if (chunk.parentId) {
        addContainsLink(chunk.parentId, chunk.id);
      }
      if (this.embeddingProvider) {
        try {
          const embedding = await this.embeddingProvider.embed(chunk.text);
          if (embedding.length > 0) batch.push({ chunkId: chunk.id, embedding });
        } catch {
          // Embedding failure is non-fatal — chunk already stored
        }
      }
    }
    if (batch.length > 0) {
      this.storage.storeEmbeddingsMany(batch, this.embeddingModel);
    }
```

**Step 5 (run-pass):** Run the repository test and the orchestrator test together to confirm the new batch path works and storeIncomingChunks behavior is preserved.
```bash
npx vitest run tests/vector-index.test.ts tests/orchestrator.test.ts
```
Expected: PASS — new storeEmbeddingsMany test + existing orchestrator tests green (storeIncomingChunks final state preserved).

**Step 6 (verify-gate):** Type-check after the repository + orchestrator wiring change.
```bash
npm run lint
```
Expected: PASS — tsc --noEmit clean.

**Step 7 (commit):** Commit the ingestion-path wiring with the exact message.

**Commit:** `Q1b: route incremental ingestion through batched storeEmbeddingsMany -> vectorIndex.addMany`

**Risks:** Phase-2 ordering changes: previously each chunk's embedding was stored before the next chunk's structure. Now all chunk_embeddings are flushed after all structures. storeIncomingChunks tests (tests/orchestrator.test.ts) must stay green — verify existing assertions only check final state, not per-chunk interleaving. The dimension-reinit guard in storeEmbeddingsMany handles the whole batch's dimension, matching storeEmbedding's single-item guard. embed() is still awaited sequentially (no embedding-provider batching claimed here — out of scope).

---

### Task Q1b.4: Full gate: npm test green + re-run blocking acceptance benchmark (honesty rule)

**Files:** Verify only: benchmarks/evaluate.ts, benchmarks/check-acceptance.ts, benchmarks/baselines/deterministic-baseline.json

**Step 1 (verify-gate):** Run the full vitest suite to confirm no existing count/loadCount contract regression across all ~503 tests.
```bash
npm test
```
Expected: PASS — full vitest suite (~503 tests) green.

**Step 2 (verify-gate):** Run type-check and build to confirm the change compiles cleanly for publish.
```bash
npm run lint && npm run build
```
Expected: PASS — tsc clean in both steps.

**Step 3 (other):** Honesty rule (design cross-cutting discipline): this changes the ingestion hot path (retrieval-adjacent storage). Re-run the BLOCKING acceptance gate to confirm no non-regression breach. Run the deterministic eval over the frozen self-corpus at depth 200, then the blocking-subset check.
```bash
BENCHMARK_RETRIEVAL_DEPTH=200 npx tsx benchmarks/evaluate.ts --corpus-snapshot benchmarks/fixtures/self-corpus.json --strategy all --json > /tmp/spacefolding-q1b-eval.json && npx tsx benchmarks/check-acceptance.ts --blocking-subset --retrieval-json /tmp/spacefolding-q1b-eval.json
```
Expected: PASS — check-acceptance blocking gate passed: all 8 strategies reported, structural/fts/bm25/keyword recall@10 & hits@1 not below deterministic-baseline.json minus margin. This is a storage-efficiency change (identical embeddings inserted), so retrieval output is byte-identical and the gate MUST stay green. If it fails, the count mirror corrupted the index contents — STOP and debug before any Q1b claim.

**Step 4 (other):** Optional scale sanity (design Q1b goal: 're-confirm 60k ingestion is materially faster'). NOT a universal-winner claim — confirm addMany removes the per-chunk COUNT(*) tax. If benchmarks/scale-benchmark.ts runs offline, time a 60k-chunk ingestion before/after on a throwaway DB. Report the delta honestly; do NOT commit any baseline change without owner sign-off.
```bash
npx tsx benchmarks/scale-benchmark.ts --help 2>&1 | head -5 || echo 'scale-benchmark not runnable offline here; skip — the COUNT(*) removal is proven by the task-2 spy test (0 scans) regardless of wall-clock.'
```
Expected: Either a usage banner (script exists) or the skip message. The load-bearing proof of the fix is the task-2 spy test (zero COUNT(*) scans + single transaction), which is deterministic and not machine-dependent.

**Step 5 (commit):** Final state: branch q1b-batched-vec0 ready for review. This task is verification-only and needs no commit if everything is already clean.

**Commit:** `Q1b: verify full suite + blocking acceptance gate green (no commit if clean)`

**Risks:** The blocking gate requires the deterministic provider and frozen corpus — if the local env lacks benchmarks/fixtures/self-corpus.json it will fail to START (not a regression). Confirm the snapshot exists before running. The honesty rule is load-bearing: do NOT claim a universal retrieval win; this phase is strictly a storage-efficiency fix that must preserve retrieval output exactly.

---

## Phase Q2 — Neural cross-encoder reranker (P5 reframed)

**Grounding (real-code facts this phase rests on):**

- `src/providers/deterministic-reranker.ts`:1-28 — DeterministicRerankerProvider implements RerankerProvider.rerank(query, documents) -> [{index,score,reason}] sorted desc; jaccard word-overlap (matchCount/queryWords.size). This is the exact interface the new CrossEncoderRerankerProvider must satisfy.
- `src/types/index.ts`:227-232 — RerankerProvider interface: rerank(query: string, documents: string[]): Promise<{index:number; score:number; reason:string}[]>. The new provider returns logit-probabilities as score and a reason like 'cross-encoder relevance'.
- `src/providers/local-embedding.ts`:1-46 — The transformers.js model-loading pattern to mirror: pipeline(env...), lazy getPipeline() with `this.loading` guard Promise, embed reads output.data. For a cross-encoder use pipeline('text-classification', ...) and pipe([query,doc]).
- `src/core/retriever.ts`:221-280 — Reranker usage site: candidates = sorted.slice(0, RERANKER_MAX_CANDIDATES=20) (line 61/224); documents built from chunk path+text (225-227); rerankResults scored into combinedScore = fusedScore + exactStructuralBoost + rerankerScore*RRF_TOP_CONTRIBUTION*3 (263). The exact-structural boost (symbolExact/pathExact) already protects top-1 and composes with any reranker. Reranker failure is non-fatal (catch, line 277).
- `src/pipeline/orchestrator.ts`:89-92 — HybridRetriever is constructed here with the reranker HARDCODED as `new DeterministicRerankerProvider()`. This is the single wiring point that must accept an injected RerankerProvider; evaluate.ts (gate) constructs PipelineOrchestrator at evaluate.ts:1488-1490.
- `src/cli/index.ts`:165-213 — Embedding provider env-switch pattern (getEmbeddingProviderName + createEmbeddingProviderConfig) to mirror for reranker selection. createPipeline (215-236) is the production construction site to add a createRerankerProvider() and pass it into PipelineOrchestrator.
- `tests/retriever-ranking.test.ts`:351-375 — Inline RerankerProvider mock pattern used by existing tests ({async rerank(){ return [{index,score,reason}...] }}) passed as 3rd arg to new HybridRetriever. The new provider's offline test will mirror this shape; the assertion `results[0].reasons contains 'reranker direct keyword match: 1.000'` confirms how reasons surface.
- `.github/workflows/ci.yml`:86-91 — The FROZEN BLOCKING ablation gate commands. acceptance-blocking job runs the two-step non-regression gate on the deterministic provider. Must be re-run before/after; assert structural/fts/bm25/keyword recall@10 & hits@1 not below pinned baseline (benchmarks/baselines/deterministic-baseline.json) − 0.03 margin.
- `benchmarks/evaluate.ts`:1506-1525 — createBenchmarkEmbeddingProvider defaults to deterministic offline (BENCH_EMBEDDING). The gate path constructs PipelineOrchestrator at 1488 and inherits the hardcoded deterministic reranker at orchestrator.ts:92 — so CI is deterministic by default. The new reranker is opt-in only via env, never changing the default gate path.
- `src/core/retriever.ts`:253-263 — RERANKER_MAX_CANDIDATES=20 already gates the candidate set sent to the reranker. The new provider adds an internal top-K-within-token-budget guard on top (truncate docs to budget; cap pairs). exactStructuralBoost uses typed symbolExact/pathExact flags (253) — the ws03 typed fields are already merged on this branch.

### Task Q2.1: Failing test for CrossEncoderRerankerProvider.rerank() offline contract

**Files:** Test: tests/cross-encoder-reranker.test.ts (new)

**Step 1 (write-failing-test):** Create tests/cross-encoder-reranker.test.ts. Cover the interface contract WITHOUT hitting the network: (a) a constructor flag `useDeterministicFallback:true` must make rerank() behave like the jaccard provider (offline/CI path, deterministic); (b) default `topK` caps the number of returned docs; (c) returned shape is {index,score,reason}[] sorted desc with reason 'cross-encoder relevance' when using the model path. The deterministic-fallback test is the load-bearing offline assertion. Mirror the inline mock pattern at tests/retriever-ranking.test.ts:351-358 for shape expectations.
```ts
import { describe, expect, it } from 'vitest';
import { CrossEncoderRerankerProvider } from '../src/providers/cross-encoder-reranker.js';

describe('CrossEncoderRerankerProvider', () => {
  it('offline fallback reranks by jaccard overlap and matches RerankerProvider shape', async () => {
    const reranker = new CrossEncoderRerankerProvider({ useDeterministicFallback: true });
    const out = await reranker.rerank('authentication middleware', [
      'nothing relevant here',
      'authentication middleware checks tokens',
    ]);
    expect(out).toHaveLength(2);
    for (const r of out) {
      expect(typeof r.index).toBe('number');
      expect(typeof r.score).toBe('number');
      expect(typeof r.reason).toBe('string');
      expect(Number.isFinite(r.score)).toBe(true);
    }
    // sorted desc by score
    expect(out[0].score).toBeGreaterThanOrEqual(out[1].score);
    // the doc with both query words wins
    expect(out[0].index).toBe(1);
  });

  it('caps returned candidates at topK', async () => {
    const reranker = new CrossEncoderRerankerProvider({ useDeterministicFallback: true, topK: 1 });
    const out = await reranker.rerank('alpha', ['alpha beta', 'gamma delta', 'alpha gamma']);
    expect(out).toHaveLength(1);
  });
});
```
```bash
npx vitest run tests/cross-encoder-reranker.test.ts
```
Expected: FAIL — Cannot find module '../src/providers/cross-encoder-reranker.js' (file does not exist yet).

**Step 2 (run-fail):** Confirm the test fails for the import-missing reason (the canonical TDD red).
```bash
npx vitest run tests/cross-encoder-reranker.test.ts
```
Expected: FAIL: Error: Failed to load url ../src/providers/cross-encoder-reranker.js ... does not provide an export named 'CrossEncoderRerankerProvider' / module not found.

**Commit:** `test(q2): failing test for CrossEncoderRerankerProvider offline contract`

**Risks:** If the test imports the module before it exists the whole file errors; that is the intended red state. Keep the offline test deterministic (jaccard fallback) so it never needs a model download in CI.

---

### Task Q2.2: Implement CrossEncoderRerankerProvider with offline fallback + top-K + token budget

**Files:** Create: src/providers/cross-encoder-reranker.ts ; Export in src/providers/index.ts

**Step 1 (implement):** Create src/providers/cross-encoder-reranker.ts mirroring src/providers/local-embedding.ts (lazy pipeline + loading guard) and src/providers/deterministic-reranker.ts (jaccard fallback). The provider takes options { modelId, useDeterministicFallback, topK, maxDocChars, tokenBudget }. When useDeterministicFallback is true (or model load fails), it delegates to the exact jaccard logic — this is the offline/CI path and keeps the test network-free. Otherwise it lazily loads a transformers.js text-classification pipeline (cross-encoder) and scores query+doc pairs, gating to topK within tokenBudget. Export it from src/providers/index.ts.
```ts
import type { RerankerProvider } from '../types/index.js';
import { DeterministicRerankerProvider } from './deterministic-reranker.js';

export interface CrossEncoderRerankerOptions {
  /** HuggingFace model id for the cross-encoder (ONNX, transformers.js). */
  modelId?: string;
  /** When true (or when the model cannot load), fall back to the deterministic
   * jaccard reranker — keeps tests/CI offline and deterministic. */
  useDeterministicFallback?: boolean;
  /** Max candidates to return after scoring. */
  topK?: number;
  /** Truncate each document to roughly this many characters before scoring
   * (token-budget guard; cross-encoders are length-sensitive and slow). */
  maxDocChars?: number;
}

export class CrossEncoderRerankerProvider implements RerankerProvider {
  private readonly modelId: string;
  private readonly topK: number;
  private readonly maxDocChars: number;
  private readonly fallback: DeterministicRerankerProvider;
  /** Set lazily on first successful model load; null while loading, false if
   * loading failed (then permanently uses fallback). */
  private modelFailed = false;
  private pipe: Awaited<ReturnType<typeof import('@huggingface/transformers').pipeline>> | null = null;
  private loading: Promise<typeof this.pipe> | null = null;

  constructor(opts: CrossEncoderRerankerOptions = {}) {
    this.modelId = opts.modelId ?? 'Xenova/bge-reranker-v2-m3';
    this.topK = opts.topK ?? 20;
    this.maxDocChars = opts.maxDocChars ?? 2048;
    this.fallback = new DeterministicRerankerProvider();
    if (opts.useDeterministicFallback) this.modelFailed = true;
  }

  async rerank(
    query: string,
    documents: string[]
  ): Promise<{ index: number; score: number; reason: string }[]> {
    if (this.modelFailed) {
      return this.fallback.rerank(query, documents).then((r) => r.slice(0, this.topK));
    }
    try {
      const pipe = await this.getPipeline();
      const pairs = documents.map((doc) => [query, doc.slice(0, this.maxDocChars)] as [string, string]);
      const scored: { index: number; score: number; reason: string }[] = [];
      for (let i = 0; i < pairs.length; i++) {
        const output = await pipe(pairs[i]);
        const prob = extractRelevanceProb(output);
        scored.push({ index: i, score: prob, reason: 'cross-encoder relevance' });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, this.topK);
    } catch (err) {
      // Model unavailable (no network / not cached) — permanently fall back so
      // subsequent calls stay cheap and offline-safe.
      this.modelFailed = true;
      return this.fallback.rerank(query, documents).then((r) => r.slice(0, this.topK));
    }
  }

  private async getPipeline() {
    if (this.pipe) return this.pipe;
    if (this.loading) return this.loading;
    const { pipeline, env } = await import('@huggingface/transformers');
    const { ensureModelCacheDir } = await import('./model-cache.js');
    env.allowLocalModels = true;
    env.localModelPath = ensureModelCacheDir();
    env.useBrowserCache = false;
    this.loading = pipeline('text-classification', this.modelId, {
      dtype: 'fp32',
      quantized: true,
      progress_callback: (p: { status: string; progress?: number; file?: string }) => {
        if (p.status === 'progress' && p.progress !== undefined) {
          process.stderr?.write?.(`\rDownloading reranker ${this.modelId}: ${p.file ?? ''} ${Math.round(p.progress)}%`);
        } else if (p.status === 'done') {
          process.stderr?.write?.('\n');
        }
      },
    }) as Promise<typeof this.pipe>;
    this.pipe = await this.loading;
    return this.pipe;
  }
}

function extractRelevanceProb(output: unknown): number {
  // transformers.js text-classification returns { label, score }[] or a Tensor.
  if (Array.isArray(output) && typeof output[0]?.score === 'number') {
    return output[0].score;
  }
  if (output && typeof output === 'object' && 'data' in output) {
    const data = (output as { data: Float32Array | number[] }).data;
    return Array.isArray(data) ? data[0] ?? 0 : data[0] ?? 0;
  }
  return 0;
}
```

**Step 2 (implement):** Add the export to src/providers/index.ts (after line 5): `export { CrossEncoderRerankerProvider } from './cross-encoder-reranker.js'; export type { CrossEncoderRerankerOptions } from './cross-encoder-reranker.js';`
```ts
export { CrossEncoderRerankerProvider } from './cross-encoder-reranker.js';
export type { CrossEncoderRerankerOptions } from './cross-encoder-reranker.js';
```

**Step 3 (run-pass):** Run the offline test; both assertions pass via the deterministic fallback path (no network).
```bash
npx vitest run tests/cross-encoder-reranker.test.ts
```
Expected: PASS — 2 tests pass (offline fallback + topK cap). No model download occurs.

**Step 4 (verify-gate):** Type-check the new provider compiles against the RerankerProvider interface.
```bash
npm run lint
```
Expected: PASS — tsc --noEmit exits 0.

**Commit:** `feat(q2): CrossEncoderRerankerProvider behind RerankerProvider (offline fallback + top-K)`

**Risks:** The transformers.js `pipeline('text-classification', ...)` task/output shape can vary by model card; the offline fallback + try/catch guarantees the contract holds even if the model output parsing is wrong, and the offline test never exercises the model path. The default model 'Xenova/bge-reranker-v2-m3' may not exist as an ONNX repo — that is acceptable because the default path is deterministic fallback; verify the actual model id before enabling in production (Task 5 risk note).

---

### Task Q2.3: Wire config/env selection of reranker (keep deterministic default for CI)

**Files:** Modify: src/pipeline/orchestrator.ts:77-93 (ctor accepts reranker) ; src/cli/index.ts:165-236 (createRerankerProvider + createPipeline) ; benchmarks/evaluate.ts:1488-1490 (optional injection)

**Step 1 (implement):** Make PipelineOrchestrator accept an optional reranker instead of hardcoding DeterministicRerankerProvider. In src/pipeline/orchestrator.ts add a trailing ctor param `reranker?: RerankerProvider` (import the type, already imported at line 7); change line 92 from `new DeterministicRerankerProvider()` to `reranker ?? new DeterministicRerankerProvider()`. Keep DeterministicRerankerProvider import + the default so existing callers are unchanged.
```ts
// orchestrator.ts constructor signature (line 77-93):
  constructor(
    private storage: SQLiteRepository,
    private scorer: ContextScorer,
    private router: ContextRouter,
    private compressionProvider: CompressionProvider,
    private dependencyAnalyzer: DependencyAnalyzer,
    private ingester: ContextIngester,
    private embeddingProvider?: EmbeddingProvider,
    embeddingModel?: string,
    reranker?: RerankerProvider,
  ) {
    this.embeddingModel = embeddingModel ?? defaultEmbeddingModelForProvider(embeddingProvider);
    this.structuralIndexer = new StructuralIndexer();
    this.retriever = new HybridRetriever(storage, embeddingProvider ?? {
      embed: async () => [],
      embedBatch: async () => [],
    }, reranker ?? new DeterministicRerankerProvider());
  }
```

**Step 2 (implement):** Add createRerankerProvider() to src/cli/index.ts mirroring getEmbeddingProviderName (lines 165-169) + createEmbeddingProviderConfig (183-213). Read process.env.RERANKER_PROVIDER ('cross-encoder' | 'deterministic', default 'deterministic') and process.env.RERANKER_MODEL. Return a CrossEncoderRerankerProvider ONLY when cross-encoder is requested; otherwise DeterministicRerankerProvider. Wire it into createPipeline (215-236) as the new trailing ctor arg.
```ts
// src/cli/index.ts
import { CrossEncoderRerankerProvider } from '../providers/cross-encoder-reranker.js';
import type { RerankerProvider } from '../types/index.js';

type RerankerProviderName = 'cross-encoder' | 'deterministic';

export function getRerankerProviderName(): RerankerProviderName {
  const provider = process.env.RERANKER_PROVIDER;
  if (provider === 'cross-encoder') return 'cross-encoder';
  return 'deterministic';
}

function createRerankerProvider(): RerankerProvider {
  if (getRerankerProviderName() === 'cross-encoder') {
    return new CrossEncoderRerankerProvider({
      modelId: process.env.RERANKER_MODEL ?? 'Xenova/bge-reranker-v2-m3',
    });
  }
  return new DeterministicRerankerProvider();
}

// in createPipeline (line 226), pass the reranker as the trailing ctor arg:
  return new PipelineOrchestrator(
    storage, scorer, router, compressionProvider, dependencyAnalyzer, ingester,
    embedding.provider, embedding.model, createRerankerProvider(),
  );
```
```bash
npm run lint
```
Expected: PASS — tsc exits 0.

**Step 3 (run-pass):** Run the existing retriever-ranking + orchestrator tests to confirm the new trailing ctor arg and default deterministic wiring do not regress anything. CI default path is still DeterministicRerankerProvider (RERANKER_PROVIDER unset).
```bash
npx vitest run tests/retriever-ranking.test.ts tests/orchestrator.test.ts
```
Expected: PASS — all existing tests green; the hardcoded-deterministic behavior is preserved when no reranker is injected.

**Commit:** `feat(q2): env-selectable reranker (RERANKER_PROVIDER) with deterministic default`

**Risks:** Any caller constructing PipelineOrchestrator positionally must keep working — adding the reranker as the LAST ctor arg and defaulting to DeterministicRerankerProvider preserves all 8 existing call sites (cli createPipeline, evaluate.ts:1488, e2e-benchmark.ts:601, orchestrator.test.ts:38, and the default-embedding mock at orchestrator.ts:89-92). evaluate.ts does NOT read RERANKER_PROVIDER, so the blocking gate path is unchanged.

---

### Task Q2.4: Confirm the new provider does not change the deterministic gate path (gate still uses DeterministicRerankerProvider)

**Files:** Verify: benchmarks/evaluate.ts:1488-1490 ; .github/workflows/ci.yml:86-91

**Step 1 (verify-gate):** Confirm evaluate.ts still constructs PipelineOrchestrator WITHOUT passing a cross-encoder reranker (line 1488-1490 passes only embedding). Because RERANKER_PROVIDER is unset in the acceptance-blocking CI job, the orchestrator defaults to DeterministicRerankerProvider. No code change needed in evaluate.ts unless we WANT the gate to exercise the cross-encoder (we do NOT for the blocking gate — it must stay deterministic/offline). Add a comment if desired but do not wire it.
```bash
grep -n "new PipelineOrchestrator\|RERANKER\|reranker" benchmarks/evaluate.ts
```
Expected: evaluate.ts constructs PipelineOrchestrator with 7 args (no reranker) -> defaults to DeterministicRerankerProvider. The blocking gate path is unchanged.

**Commit:** `no change — gate path stays deterministic (documented)`

**Risks:** If a future change sets RERANKER_PROVIDER=cross-encoder in CI, the gate would download a model and become non-deterministic. Mitigation: the offline fallback in the provider still makes it jaccard-equivalent if the model can't load, but the cleaner guarantee is that the gate never sets RERANKER_PROVIDER. Flag this in commit/PR notes.

---

### Task Q2.5: Re-run the FROZEN blocking ablation gate before AND after, assert exact-identifier top-1 non-regression (honesty gate)

**Files:** Run: benchmarks/evaluate.ts + benchmarks/check-acceptance.ts (frozen commands from ci.yml:86-91)

**Step 1 (verify-gate):** BEFORE the provider is selectable, capture the baseline gate output on this branch. Produce eval JSON with the frozen deterministic corpus+depth, then run the blocking-subset check. Record which checks pass. This is the reference for non-regression.
```bash
npm run build && BENCHMARK_RETRIEVAL_DEPTH=200 npx tsx benchmarks/evaluate.ts --corpus-snapshot benchmarks/fixtures/self-corpus.json --strategy all --json > /tmp/q2-eval-before.json; npx tsx benchmarks/check-acceptance.ts --blocking-subset --retrieval-json /tmp/q2-eval-before.json; echo "exit=$?"
```
Expected: Acceptance gate: PASS, exit 0. blocking.structural_hitsAt1_no_regression and blocking.structural_recallAt10_no_regression both PASS (the durable exact-identifier top-1 edge). Record exact values.

**Step 2 (verify-gate):** AFTER Tasks 2-3 land, re-run the EXACT same frozen command. Because the default path is still DeterministicRerankerProvider, the numbers should be byte-identical / within the deterministic band. Assert NO blocking.*_no_regression check flips to FAIL. This is the load-bearing honesty gate: the change must preserve or improve the exact-identifier top-1 edge, and we make NO universal-winner claim.
```bash
npm run build && BENCHMARK_RETRIEVAL_DEPTH=200 npx tsx benchmarks/evaluate.ts --corpus-snapshot benchmarks/fixtures/self-corpus.json --strategy all --json > /tmp/q2-eval-after.json; npx tsx benchmarks/check-acceptance.ts --blocking-subset --retrieval-json /tmp/q2-eval-after.json; echo "exit=$?"
```
Expected: Acceptance gate: PASS, exit 0. structural hits@1 / recall@10 identical to before (default deterministic reranker unchanged). If RERANKER_PROVIDER=cross-encoder is later exercised locally with a downloaded model, the same gate must STILL PASS before merge — and the result is reported as a non-regression, never 'we beat the baseline universally'.

**Step 3 (verify-gate):** Run the full suite to confirm no regressions anywhere.
```bash
npm test
```
Expected: All test files pass (baseline ~503 tests green).

**Commit:** `test(q2): re-run frozen blocking ablation before/after; assert top-1 non-regression (no universal-winner claim)`

**Risks:** MODEL DOWNLOAD RISK: actually exercising RERANKER_PROVIDER=cross-encoder locally downloads a multi-hundred-MB ONNX model on first run (transformers.js progress_callback). CI never does this (env unset) so CI stays deterministic and network-free. Honesty risk: a cross-encoder may move aggregate NDCG@10 up while eroding the exact-identifier top-1 edge (the project's durable moat). The gate is the ONLY authority — if the cross-encoder path fails blocking.structural_hitsAt1_no_regression, it must NOT be the default and must be gated/documented as non-default. Never publish a 'cross-encoder is universally better' claim; report it as ablation-gated, default-off.

---

## Phase Q3 — structuredContent + resource_link MCP surface (pre-D5)

**Grounding (real-code facts this phase rests on):**

- `src/mcp/server.ts`:541-544 — Server is constructed with { capabilities: { tools: {} } } — no structuredContent advertisement. Phase must add structuredContent capability here.
- `src/mcp/server.ts`:899-916 — jsonResponse/textResponse/errorResponse each return only { content: [{ type:'text', text }] }. No path returns structuredContent or resource_link content blocks today.
- `src/mcp/server.ts`:665-712 — retrieve_context handler: format==='pack' -> textResponse(formatContextPack); else jsonResponse({...buildRetrieveResponseBody(result), ...folded}). This is where structuredContent + resource_links + response_format(concise/detailed) must hook in.
- `src/mcp/server.ts`:933-964 — buildRetrieveResponseBody(result) maps per-chunk fields + diagnostics; shared by retrieve_context (708) and get_context_for_task (881). Legacy output shape must be preserved as the 'detailed' body.
- `src/mcp/server.ts`:22 — VALID_RETRIEVE_FORMATS = ['json','pack'] at line 22; response_format (concise/detailed) is a NEW param, validated in the same pattern (validateArgs lines 1022-1026).
- `src/mcp/server.ts`:846-885 — get_context_for_task calls buildRetrieveResponseBody(result) and returns jsonResponse({task, ...body}). For parity it must also gain structuredContent + resource_links; shares the response builder.
- `node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts`:2007-2045 — ResourceLinkSchema requires { type:'resource_link', uri:string, name:string } with optional title/description/mimeType/size/annotations. name is REQUIRED — must synthesize a file:symbol name per chunk.
- `node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts`:8078 — export type ResourceLink = Infer<typeof ResourceLinkSchema> — importable from @modelcontextprotocol/sdk/types.js
- `node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts`:2501 — CallToolResultSchema includes structuredContent (Record<string,unknown> optional) — adding structuredContent to the response object is SDK-valid.
- `node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.d.ts`:511 — Client.callTool result exposes structuredContent?: Record<string,unknown> | undefined — tests assert response.structuredContent directly.
- `src/storage/repository.ts`:350-368 — SQLiteRepository.getCodeSymbols(chunkId) returns CodeSymbol[] (name/kind/path). The resolver for chunk id -> symbol name. Reachable only via pipeline (storage is private).
- `src/pipeline/orchestrator.ts`:78 — constructor(private storage: SQLiteRepository) — storage is private; a new public accessor getSymbolsForChunk(id) must be added to expose getCodeSymbols to the server layer.
- `src/types/index.ts`:121-134 — CodeSymbol has name/normalizedName/kind/path/isExported — the source for file:symbol resolution.
- `tests/mcp-ux.test.ts`:18-53 — createEmptyPipeline + callTool(pipeline, name, args) helper: in-memory Client+Server, returns {isError, text}. Tests must extend callTool to also return structuredContent + content (resource_link blocks).
- `tests/mcp-ux.test.ts`:231-244 — Existing invariant test: default retrieve_context response has routingExplanation/routing undefined and chunks array. The concise/detailed + structuredContent change must keep this default-shape test green (detailed is the default).
- `.github/workflows/ci.yml`:88-91 — Frozen blocking ablation gate command: BENCHMARK_RETRIEVAL_DEPTH=200 ... evaluate.ts --corpus-snapshot self-corpus.json --strategy all --json > eval.json ; check-acceptance.ts --blocking-subset --retrieval-json eval.json
- `src/mcp/server.ts`:1022-1026 — validateArgs validates format against VALID_RETRIEVE_FORMATS for retrieve_context. response_format validation must mirror this pattern (new VALID_RESPONSE_FORMATS const).

### Task Q3.1: Advertise structuredContent capability in server construction

**Files:** Modify: src/mcp/server.ts:541-544 ; Test: tests/mcp-ux.test.ts

**Step 1 (write-failing-test):** Add a test asserting the server capabilities include tools.structuredContent=true via the in-memory client's getServerCapabilities().
```ts
describe('Q3 structuredContent capability advertisement', () => {
  it('advertises structuredContent in server capabilities', async () => {
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      const server = createMCPServer(pipeline);
      const client = new Client({ name: 'sf-cap-test', version: '0.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const caps = client.getServerCapabilities();
        expect(caps?.tools?.structuredContent).toBe(true);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      pipeline.close();
      void dbPath;
    }
  });
});
```

**Step 2 (run-fail):** Run the new test; confirm it fails because caps.tools.structuredContent is currently undefined.
```bash
npx vitest run tests/mcp-ux.test.ts -t "advertises structuredContent in server capabilities"
```
Expected: FAIL — expected true, received undefined.

**Step 3 (implement):** Change the Server construction to advertise structuredContent under tools.
```ts
// src/mcp/server.ts:541-544
  const server = new Server(
    { name: 'spacefolding', version: '0.1.0' },
    // structuredContent: machine-readable results returned out of model context
    // (MCP 2025-06-18). resource_link content blocks accompany retrieve responses
    // for lazy sf://chunk/{id} resolution. resources/prompts/elicitation are NOT
    // advertised — verify Claude Code host support before investing (see Q3 note).
    { capabilities: { tools: { structuredContent: true } } }
  );
```

**Step 4 (run-pass):** Re-run the new test to confirm PASS.
```bash
npx vitest run tests/mcp-ux.test.ts -t "advertises structuredContent in server capabilities"
```
Expected: PASS.

**Step 5 (verify-gate):** Type-check the change.
```bash
npm run lint
```
Expected: No type errors.

**Step 6 (commit):** commit with exact message.

**Commit:** `feat(mcp): advertise structuredContent tool capability`

**Risks:** Low. Capability advertisement is additive; clients that ignore it are unaffected.

---

### Task Q3.2: Add response_format (concise|detailed) param + validation, default detailed (preserves legacy shape)

**Files:** Modify: src/mcp/server.ts:22,89,676,1022-1026 ; Test: tests/mcp-ux.test.ts

**Step 1 (write-failing-test):** Add tests: (a) invalid response_format rejected by validateArgs; (b) default returns the full legacy body; (c) concise returns only id/path/type/text/tier and drops diagnostics. Import validateArgs in the test (already exported).
```ts
describe('Q3 response_format (concise/detailed)', () => {
  it('rejects an invalid response_format', () => {
    const err = validateArgs({ query: 'x', response_format: 'verbose' }, 'retrieve_context');
    expect(err).toMatch(/response_format must be one of/);
  });

  it('detailed (default) returns the full legacy body including diagnostics', async () => {
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      await pipeline.ingest('file', 'function detailedShape() { return 1; }', 'code', 'src/d.ts', 'typescript');
      const result = await callTool(pipeline, 'retrieve_context', { query: 'detailed shape' });
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      expect(Array.isArray(parsed.chunks)).toBe(true);
      expect(parsed).toHaveProperty('totalTokens');
      expect(parsed).toHaveProperty('selectionPolicy');
    } finally { pipeline.close(); void dbPath; }
  });

  it('concise drops heavy diagnostics from the model-visible text', async () => {
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      await pipeline.ingest('file', 'function conciseShape() { return 2; }', 'code', 'src/c.ts', 'typescript');
      const result = await callTool(pipeline, 'retrieve_context', { query: 'concise shape', response_format: 'concise' });
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      expect(Array.isArray(parsed.chunks)).toBe(true);
      const chunk = (parsed.chunks as Array<Record<string, unknown>>)[0];
      expect(chunk).toHaveProperty('id');
      expect(chunk).toHaveProperty('path');
      expect(chunk).toHaveProperty('text');
      expect(parsed).not.toHaveProperty('selectionPolicy');
    } finally { pipeline.close(); void dbPath; }
  });
});
```

**Step 2 (run-fail):** Run the validation test; confirm it fails (no validation yet) and concise fails (not wired).
```bash
npx vitest run tests/mcp-ux.test.ts -t "response_format (concise/detailed)"
```
Expected: FAIL — validateArgs returns undefined for 'verbose'; concise body not trimmed.

**Step 3 (implement):** Add VALID_RESPONSE_FORMATS const, the schema property, the validateArgs branch, and read responseFormat in the handler (concise wiring is in task 4).
```ts
// src/mcp/server.ts line 22 — add next to VALID_RETRIEVE_FORMATS:
const VALID_RESPONSE_FORMATS = ['concise', 'detailed'] as const;

// RETRIEVE_CONTEXT_INPUT_SCHEMA properties (after `score` at line 89) add:
    response_format: {
      type: 'string',
      enum: VALID_RESPONSE_FORMATS,
      description: 'Model-visible text verbosity. detailed (default) returns the full legacy body. concise returns only id/path/type/text/tier per chunk and moves scores/diagnostics into structuredContent to cut tokens.',
    },

// validateArgs — after the format check (line 1026) add:
  if (toolName === 'retrieve_context' && args.response_format !== undefined) {
    if (!VALID_RESPONSE_FORMATS.includes(args.response_format as typeof VALID_RESPONSE_FORMATS[number])) {
      return `response_format must be one of: ${VALID_RESPONSE_FORMATS.join(', ')}`;
    }
  }

// retrieve_context handler (line 676, near `const format = ...`):
          const responseFormat = (args!.response_format as string | undefined) ?? 'detailed';
// pass responseFormat into the response builder (task 4).
```

**Step 4 (run-pass):** Validation + detailed-default tests pass (detailed is a no-op on the existing body). The concise test stays red until task 4 — commit only validation+param+detailed.
```bash
npx vitest run tests/mcp-ux.test.ts -t "rejects an invalid response_format" && npx vitest run tests/mcp-ux.test.ts -t "detailed (default) returns the full legacy body"
```
Expected: Both PASS.

**Step 5 (commit):** commit message exact.

**Commit:** `feat(mcp): add response_format (concise|detailed) param with validation, default detailed`

**Risks:** Default=detailed keeps every existing shape test green. The concise branch test remains red between this commit and task 4 (TDD cadence).

---

### Task Q3.3: Expose chunk->symbol resolution on PipelineOrchestrator (file:symbol names)

**Files:** Modify: src/pipeline/orchestrator.ts (after getAllChunks at line 466) ; Test: tests/orchestrator.test.ts

**Step 1 (write-failing-test):** Add tests to tests/orchestrator.test.ts: getSymbolsForChunk returns CodeSymbol[] for a code chunk (each with .name string) and [] for unknown ids.
```ts
// tests/orchestrator.test.ts — add inside a describe:
  it('getSymbolsForChunk resolves a chunk id to its code symbols', async () => {
    const chunk = await pipeline.ingest('file', 'function resolveMe() { return 1; }', 'code', 'src/resolve.ts', 'typescript');
    const symbols = pipeline.getSymbolsForChunk(chunk.id);
    expect(Array.isArray(symbols)).toBe(true);
    for (const s of symbols) {
      expect(typeof s.name).toBe('string');
    }
  });

  it('getSymbolsForChunk returns [] for an unknown chunk id', () => {
    expect(pipeline.getSymbolsForChunk('does-not-exist')).toEqual([]);
  });
```

**Step 2 (run-fail):** Run the new tests; confirm failure (method does not exist).
```bash
npx vitest run tests/orchestrator.test.ts -t "getSymbolsForChunk"
```
Expected: FAIL — pipeline.getSymbolsForChunk is not a function.

**Step 3 (implement):** Add the accessor delegating to storage.getCodeSymbols (src/storage/repository.ts:350) with a try/catch guard. Returns CodeSymbol[].
```ts
// src/pipeline/orchestrator.ts — add after getAllChunks() (line 466):
  /**
   * Resolves a chunk id to its code symbols (name/kind/path) for human-readable
   * file:symbol naming in MCP responses. Returns [] for unknown ids or chunks
   * without stored structure. Used by the Q3 structuredContent/resource_link
   * surface to turn opaque chunk IDs into agent-legible names.
   */
  getSymbolsForChunk(chunkId: string): import('../types/index.js').CodeSymbol[] {
    try {
      return this.storage.getCodeSymbols(chunkId);
    } catch {
      return [];
    }
  }
```
```bash
npm run lint
```
Expected: No errors.

**Step 4 (run-pass):** Re-run the new tests; confirm PASS.
```bash
npx vitest run tests/orchestrator.test.ts -t "getSymbolsForChunk"
```
Expected: PASS.

**Step 5 (commit):** commit message exact.

**Commit:** `feat(pipeline): expose getSymbolsForChunk for chunk->symbol resolution`

**Risks:** Trivial pass-through; try/catch guards storage edge cases. CodeSymbol import path confirmed at src/types/index.ts:121.

---

### Task Q3.4: Response builder: structuredContent + resource_link blocks + concise text + file:symbol resolution; wire retrieve_context and get_context_for_task

**Files:** Modify: src/mcp/server.ts:665-712,846-885,933-964,899-916 ; Test: tests/mcp-ux.test.ts

**Step 1 (write-failing-test):** Extend callTool to surface structuredContent + all content blocks. Assert: concise returns (a) structuredContent with scores + chunks, (b) a resource_link per chunk with sf://chunk/{id} and a non-empty name, (c) concise text. Also assert detailed-default carries structuredContent + resource_links additively without changing legacy body keys.
```ts
// tests/mcp-ux.test.ts — replace callTool (lines 35-53):
async function callTool(
  pipeline: PipelineOrchestrator,
  name: string,
  args: Record<string, unknown>
): Promise<{ isError?: boolean; text: string; structuredContent?: Record<string, unknown>; content: Array<Record<string, unknown>> }> {
  const server = createMCPServer(pipeline);
  const client = new Client({ name: 'sf-mcpux-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const response = await client.callTool({ name, arguments: args });
    const textItem = response.content.find((item) => (item as { type?: string }).type === 'text');
    return {
      isError: response.isError,
      text: (textItem as { text?: string })?.text ?? '',
      structuredContent: response.structuredContent as Record<string, unknown> | undefined,
      content: response.content as Array<Record<string, unknown>>,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('Q3 structuredContent + resource_link surface', () => {
  it('retrieve_context concise returns structuredContent with scores and a resource_link per chunk', async () => {
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      await pipeline.ingest('file', 'function structMe() { return true; }', 'code', 'src/struct.ts', 'typescript');
      const result = await callTool(pipeline, 'retrieve_context', { query: 'struct me', response_format: 'concise' });
      expect(result.structuredContent).toBeDefined();
      const sc = result.structuredContent!;
      expect(sc).toHaveProperty('scores');
      expect(sc).toHaveProperty('chunks');
      const links = result.content.filter((b) => b.type === 'resource_link');
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        expect(String(link.uri)).toMatch(/^sf:\/\/chunk\//);
        expect(typeof link.name).toBe('string');
        expect(link.name.length).toBeGreaterThan(0);
      }
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      expect(Array.isArray(parsed.chunks)).toBe(true);
      expect(parsed).not.toHaveProperty('selectionPolicy');
    } finally { pipeline.close(); void dbPath; }
  });

  it('retrieve_context default (detailed) ALSO carries structuredContent + resource_links without changing legacy keys', async () => {
    const { pipeline, dbPath } = createEmptyPipeline();
    try {
      await pipeline.ingest('file', 'function detailedStruct() { return 1; }', 'code', 'src/d2.ts', 'typescript');
      const result = await callTool(pipeline, 'retrieve_context', { query: 'detailed struct' });
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      expect(parsed).toHaveProperty('selectionPolicy');
      expect(parsed).toHaveProperty('totalTokens');
      expect(result.structuredContent).toBeDefined();
      expect(result.content.some((b) => b.type === 'resource_link')).toBe(true);
    } finally { pipeline.close(); void dbPath; }
  });
});
```

**Step 2 (run-fail):** Run the new tests; confirm failure (structuredContent undefined, no resource_link blocks, concise not trimmed).
```bash
npx vitest run tests/mcp-ux.test.ts -t "structuredContent + resource_link surface"
```
Expected: FAIL — result.structuredContent undefined; no resource_link; concise body not trimmed.

**Step 3 (implement):** Add chunkDisplayName, buildStructuredSurface, buildConciseText, jsonResponseStructured helpers; rewrite the retrieve_context and get_context_for_task tails. The existing hardBudget (server.ts:865) is the hard token cap; concise note adds narrow-your-query steering. jsonResponse stays for all non-retrieve tools (legacy preserved).
```ts
// src/mcp/server.ts — add near jsonResponse (line 899):

function chunkDisplayName(
  chunk: { id: string; path?: string; source: string; type: string },
  symbols: Array<{ name: string }>
): string {
  const loc = chunk.path ?? chunk.source;
  if (symbols.length > 0) return `${loc}:${symbols[0]!.name}`;
  return loc || chunk.type;
}

function buildStructuredSurface(
  result: RetrieveResult,
  pipeline: PipelineOrchestrator
): { structuredContent: Record<string, unknown>; resourceLinks: Array<Record<string, unknown>> } {
  const entries = result.chunks.map((c) => {
    const baseId = c.id.split('__compressed')[0];
    const retrieval = result.retrieval.find((r) => r.chunkId === baseId);
    const symbols = pipeline.getSymbolsForChunk(c.id);
    return { chunk: c, retrieval, symbols, name: chunkDisplayName(c, symbols), tier: result.tiers.get(c.id) ?? 'warm' };
  });
  const scores: Record<string, unknown> = {};
  const sources: Record<string, unknown> = {};
  for (const e of entries) {
    if (e.retrieval?.sourceScores) scores[e.chunk.id] = e.retrieval.sourceScores;
    if (e.retrieval?.sources) sources[e.chunk.id] = e.retrieval.sources;
  }
  const structuredContent = {
    scores,
    sources,
    chunks: entries.map((e) => ({ id: e.chunk.id, path: e.chunk.path, symbol: e.symbols[0]?.name ?? null, tier: e.tier, tokens: e.chunk.tokensEstimate })),
  };
  const resourceLinks = entries.map((e) => ({
    type: 'resource_link' as const,
    uri: `sf://chunk/${encodeURIComponent(e.chunk.id)}`,
    name: e.name,
    description: `${e.chunk.type} chunk (${e.tier})`,
  }));
  return { structuredContent, resourceLinks };
}

function buildConciseText(result: RetrieveResult, pipeline: PipelineOrchestrator): unknown {
  return {
    chunks: result.chunks.map((c) => ({
      id: c.id,
      path: c.path,
      type: c.type,
      text: c.text,
      tier: result.tiers.get(c.id) ?? 'warm',
      name: chunkDisplayName(c, pipeline.getSymbolsForChunk(c.id)),
    })),
    totalTokens: result.totalTokens,
    budget: result.budget,
    hardBudget: result.hardBudget,
    utilization: result.utilization,
    note: 'Concise view. Full scores/sources/diagnostics are in structuredContent (out of context). If results are too broad, narrow your query with a specific identifier (function/type name).',
  };
}

function jsonResponseStructured(data: unknown, structuredContent: Record<string, unknown>, resourceLinks: Array<Record<string, unknown>>) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(data, null, 2) },
      ...(resourceLinks.map((link) => ({ ...link }) as object)),
    ],
    structuredContent,
  };
}

// retrieve_context handler tail (replace lines 708-712):
          const responseFormat = (args!.response_format as string | undefined) ?? 'detailed';
          const body = { ...buildRetrieveResponseBody(result), ...folded };
          const { structuredContent, resourceLinks } = buildStructuredSurface(result, pipeline);
          if (responseFormat === 'concise') {
            return jsonResponseStructured(buildConciseText(result, pipeline), structuredContent, resourceLinks);
          }
          return jsonResponseStructured(body, structuredContent, resourceLinks);

// get_context_for_task handler tail (replace lines 881-884):
          const { structuredContent: sc, resourceLinks: rl } = buildStructuredSurface(result, pipeline);
          return jsonResponseStructured({ task, ...buildRetrieveResponseBody(result) }, sc, rl);

// Hard token cap: existing hardBudget (server.ts:865) is the cap. A stricter
// default cap would be a retrieval/ranking change and MUST be ablation-gated
// (honesty rule) — deferred.
```
```bash
npm run lint
```
Expected: No type errors.

**Step 4 (run-pass):** Re-run the new structured-surface tests; confirm both pass.
```bash
npx vitest run tests/mcp-ux.test.ts -t "structuredContent + resource_link surface"
```
Expected: PASS for both concise and detailed-default structured tests.

**Step 5 (verify-gate):** Run full MCP + interface suites to confirm legacy detailed output shapes are preserved (the default-shape invariant test at mcp-ux.test.ts:231-244 must stay green).
```bash
npx vitest run tests/mcp-ux.test.ts tests/interface.test.ts
```
Expected: All PASS — legacy detailed body keys unchanged; structuredContent/resource_links are additive.

**Step 6 (verify-gate):** Honesty-rule regression net: this is an MCP-surface change (NOT retrieval/ranking), but run the frozen blocking gate to confirm no perturbation. Do NOT claim a winner from this run.
```bash
BENCHMARK_RETRIEVAL_DEPTH=200 npx tsx benchmarks/evaluate.ts --corpus-snapshot benchmarks/fixtures/self-corpus.json --strategy all --json > /tmp/q3-eval.json && npx tsx benchmarks/check-acceptance.ts --blocking-subset --retrieval-json /tmp/q3-eval.json
```
Expected: All blocking.* checks PASS (no regression); eval JSON identical modulo noise.

**Step 7 (commit):** commit message exact.

**Commit:** `feat(mcp): return structuredContent + resource_link items for retrieve/get_context; add concise response_format and file:symbol names`

**Risks:** Legacy detailed shape MUST stay byte-identical in its text-body keys (the surface is additive: text content unchanged + extra resource_link content blocks + structuredContent). The default-shape invariant test (mcp-ux.test.ts:231-244) guards this. getSymbolsForChunk returns [] for non-code/unknown chunks -> chunkDisplayName falls back to path/source/type so resource_link.name is always non-empty. Q3 design caveat: do NOT advertise resources/prompts/elicitation capabilities — verify Claude Code host support first; structuredContent + resource_link are safe (additive, spec 2025-06-18).

---

## Phase Q4 — D5 — npm publish + sharpened positioning (owner-gated, no retrieval/ranking code change)

**Grounding (real-code facts this phase rests on):**

- `package.json`:1-60 — name=spacefolding (FREE on npm, npm view returns E404), version=0.1.0, bin=dist/main.js, files allowlist (lines 19-33) already clean: dist, README.md, LICENSE, CHANGELOG.md, docs/index.md, docs/integration-guide.md, docs/configuration.md, docs/logo*.svg, docs/concepts, docs/howto, docs/reference, docs/tutorials. description line 4 = 'Spacefolding — local codebase context engine for coding agents' (one of the 4 divergent taglines to converge). build=tsc, test=vitest run, lint=tsc --noEmit.
- `README.md`:1-16 — Current launch README leads with badges + tagline line 13 'Local codebase context engine for coding agents.' + 'Find the right files, symbols, and snippets before an agent edits.' Does NOT lead with top-1 localization, does NOT name context rot, does NOT state the local×invisible×structural triple. Must be rewritten to lead with the durable edge.
- `README.md`:166-207 — Current benchmark section leads with '139 / 180 vs 35 / 180' aggregate and 'put the file in the first few results' — NOT the scoped, ablation-honest FROZEN-CLAIM framing. The frozen claim says NO universal winner and the edge is Hits@1 over FTS on django+typescript only (collapses under symbol-removed ablation). README must be aligned to FROZEN-CLAIM, not overclaim.
- `benchmarks/FROZEN-CLAIM.md`:9-23 — The canonical publishable claim: 'competitive with strongest lexical on recall@10 across django/typescript/rust, significantly beats pure vector on R@10 in all three. One durable genuine edge = top-1 localization (Hits@1) over FTS, holds on django+typescript NOT rust. NO universal winner: BM25F beats hybrid on Hits@1 on django and rust. Composite gate PASSES django+typescript, FAILS rust.' This is the source of truth for all positioning copy.
- `benchmarks/FROZEN-CLAIM.md`:76-94 — The edge is EXACT-IDENTIFIER lookup not semantic understanding: under symbol-removed ablation top-1 collapses (django 0.875->0.524, typescript 0.604->0.320). Claim holds ONLY on GPU code-embedding model; on deterministic/hash provider the vector arm is ~random and composite gate FAILS typescript/rust. This is the honesty caveat that MUST appear in README + a separate honest-caveat block.
- `LICENSING.md`:1-43 — License is FSL-1.1-ALv2 (Functional Source License, Sentry). Free for internal/edu/research/non-competing; commercial license required for Competing Use; auto-converts to Apache-2.0 on 2nd anniversary of each release. LICENSING.md:29 has a TODO(owner) for commercial-license contact that must be resolved or acknowledged before publish. Must be framed as 'source-available, converts to Apache 2.0 in 2y', NOT 'open source'.
- `src/providers/local-embedding.ts`:19,59 — Default model = Xenova/bge-small-en-v1.5 (constructor default line 19, downloadModel default line 59). This is the model the clean-install smoke must download and use.
- `src/cli/commands/init.ts`:44-138 — init builds .mcp.json. npx form (line 54: command 'npx', args ['-y','spacefolding','serve']) is the default; --local writes node /abs/path/dist/main.js serve form. Pre-warms model (line 123, retries lazily on failure). docs/integration-guide.md:32-41 shows the published npx .mcp.json shape — must stay correct after publish.
- `docs/integration-guide.md`:25-55 — Published integration recipe: `spacefolding init` writes .mcp.json with npx -y spacefolding serve. MODEL_PATH defaults to XDG cache (shared global), DB_PATH defaults to ./data/spacefolding.db (per-project). This is the .mcp.json correctness surface — must verify the npx form actually resolves to the published package.
- `.github/workflows/ci.yml`:86-91 — The frozen blocking gate as run in CI: BENCHMARK_RETRIEVAL_DEPTH=200 npx tsx benchmarks/evaluate.ts --corpus-snapshot benchmarks/fixtures/self-corpus.json --strategy all --json > eval.json, then npx tsx benchmarks/check-acceptance.ts --blocking-subset --retrieval-json eval.json. Regime-robust (deterministic), non-flaky, frozen self-corpus snapshot. This is the gate to re-run as the publish regression guard.
- `benchmarks/check-acceptance.ts`:55-69,628-634 — --blocking-subset flag (line 55) requires --retrieval-json (line 69 throws if missing). Exit code 1 on FAIL (lines 628, 634). Output line 599 'Acceptance gate: PASS|FAIL'. This is the exact command contract for the gate step.
- `benchmarks/dataset.json`:1-15 — Reproducible single-task smoke target: task id T02, query 'How does the scoring engine weight different factors?', relevant_files ['src/core/scorer.ts','src/core/router.ts']. Used by the deterministic self-benchmark, so a clean-install retrieval returning src/core/scorer.ts in top results reproduces a published result within the non-determinism band (deterministic provider is exact/non-flaky per FROZEN-CLAIM:86-93).
- `README.md`:237-242 — Current license paragraph already frames FSL correctly ('free for internal, educational, research, and non-competing use; commercial license required for Competing Use; FSL auto-converts to Apache-2.0 two years after each release'). This is accurate and should be preserved/tightened (prepend 'source-available'), not rewritten wholesale.

### Task Q4.1: Converge the tagline to ONE local-first context-engineering framing across all 4 surfaces

**Files:** Modify: README.md:13 (hero tagline); CLAUDE.md:3 (integration tagline); docs/index.md:12 (docs hub tagline); package.json:4 (npm description field). No test file (docs are not unit-tested; verify via grep).

**Step 1 (write-failing-test):** Write a throwaway shell check (NOT a vitest test, since docs aren't unit-tested here) that asserts exactly ONE tagline string appears across the 4 surfaces and that it uses the context-engineering framing. Expect FAIL before edit: 4 different taglines, none say 'context-engineering'.
```ts
# expect FAIL: 4 different taglines, none say 'context-engineering'
```
```bash
grep -n 'context engine for coding agents\|context-engineering' README.md CLAUDE.md docs/index.md package.json
```

**Step 2 (run-fail):** Run the failing assertion to confirm the new tagline is not yet present anywhere.
```bash
grep -c 'local-first context-engineering engine' README.md CLAUDE.md docs/index.md package.json
```
Expected: 0 matches everywhere (FAIL) — confirms the new tagline is not yet present.

**Step 3 (implement):** Replace all 4 taglines with the single approved framing so all 4 are byte-identical. (a) README.md:13 hero line -> '<strong>The local-first context-engineering engine for coding agents.</strong>' (b) CLAUDE.md:3 blockquote -> '> **The local-first context-engineering engine for coding agents.**' (drop the 'Fold infinite context space...' second clause to remove divergence) (c) docs/index.md:12 blockquote -> '> **The local-first context-engineering engine for coding agents.**' (d) package.json:4 description -> '"description": "Spacefolding — the local-first context-engineering engine for coding agents"'. Do NOT touch the longer body copy yet (that is task 2).

**Step 4 (run-pass):** Confirm all 4 surfaces now carry the identical tagline string.
```bash
grep -rn 'local-first context-engineering engine' README.md CLAUDE.md docs/index.md package.json
```
Expected: Exactly 4 matches (one per surface), identical string. PASS.

**Step 5 (verify-gate):** Run lint + full suite to confirm the docs + package.json change broke nothing (no code changed so tests must stay green).
```bash
npm run lint && npm test 2>&1 | tail -3
```
Expected: tsc --noEmit clean; vitest 'Tests 503 passed (503)'.

**Step 6 (commit):** Commit with the exact message below.

**Commit:** `docs(positioning): converge 4 divergent taglines to one local-first context-engineering framing`

**Risks:** package.json description is indexed by npm search — keep under the npm display limit (~350 chars; this is ~80). The 'context-engineering' term is newer than 'context engine'; the design explicitly mandates the new framing. No ablation re-run needed (no retrieval code touched).

---

### Task Q4.2: Rewrite the launch README to lead with top-1 localization, name context rot, state the triple, align claims to FROZEN-CLAIM (no overclaim)

**Files:** Modify: README.md:1-50 (hero + 'What Spacefolding Does'), README.md:166-207 (benchmarks section). Verify against benchmarks/FROZEN-CLAIM.md:9-23 and :76-94.

**Step 1 (write-failing-test):** Assert the README leads with top-1 localization (not 'beats grep' / not the 139/180 aggregate first), names context rot, states the triple, and contains the 'no universal winner' caveat. Expect FAIL (none present in hero/early README).
```ts
# all of these should currently be ABSENT from the hero/early README
```
```bash
grep -ni 'top-1 localization\|Hits@1\|context rot\|local.first.*invisible.*structural\|no universal winner' README.md | head
```

**Step 2 (run-fail):** Confirm neither the durable-edge lead nor the context-rot framing is present.
```bash
grep -ci 'top-1 localization' README.md; grep -ci 'context rot' README.md
```
Expected: 0 and 0 (FAIL).

**Step 3 (implement):** Rewrite README.md hero and 'What Spacefolding Does' (lines ~28-50) AND the benchmarks section (lines ~166-207). (a) Lead with the durable edge: 'Spacefolding's proven edge is top-1 localization (Hits@1) over lexical search on django and typescript — putting the exact owning file at rank 1 before an agent guesses — using structural signals (paths, symbols, references) with no compiler index.' (b) Name context rot: 'Long context degrades non-linearly (Chroma, Context Rot), so the engine narrows to the few right files instead of dumping the repo.' (c) State the triple: 'Local-first x invisible-plugin (4 advertised MCP tools) x structural+vector hybrid.' (d) In the benchmarks section REPLACE the bare '139/180 vs 35/180' lead with the scoped FROZEN-CLAIM framing: cite Hits@1 over FTS (django +0.230, typescript +0.110, rust ns), state 'no universal winner — BM25F leads top-1 on django and rust', link benchmarks/FROZEN-CLAIM.md. Keep the existing 139/180 numbers but reframe as the structural-vs-keyword recall signal, NOT the headline. Preserve the accurate FSL paragraph at lines 237-242 (tightened in task 3). Use the exact honest-caveat copy from task 4 as a blockquote.

**Step 4 (run-pass):** Confirm the new lead phrases are present in the rewritten README.
```bash
grep -ci 'top-1 localization\|context rot\|no universal winner' README.md
```
Expected: >=3 matches (one per phrase). PASS.

**Step 5 (verify-gate):** Run lint + full suite; docs-only change, no test impact expected.
```bash
npm run lint && npm test 2>&1 | tail -3
```
Expected: lint clean; 503 tests passed.

**Step 6 (commit):** Commit with the exact message below.

**Commit:** `docs(readme): lead with top-1 localization, name context rot, state the local×invisible×structural triple, align to FROZEN-CLAIM`

**Risks:** Honesty-critical: README must NOT claim 'beats grep' as the headline and must NOT imply a universal winner. The grep head-to-head win (GREP-HEADTOHEAD.md) is a tokens-to-first-correct-file efficiency result on >=10k-file repos — mentionable as a secondary efficiency point but must not displace the scoped top-1-localization lead. If unsure of a number, cite FROZEN-CLAIM.md verbatim. No ablation re-run (no retrieval code).

---

### Task Q4.3: Frame FSL-1.1->Apache accurately (source-available, NOT open source); model positioning on sqlite-vec v0.1.0; resolve/acknowledge commercial-contact TODO

**Files:** Modify: README.md:1-6 (license badge alt + one-line framing under hero) and README.md:237-242 (license section tighten). Verify/Modify: LICENSING.md:29-34 (TODO(owner) commercial contact).

**Step 1 (write-failing-test):** Assert the README never calls Spacefolding 'open source' and uses 'source-available' + the 2-year Apache conversion; assert the commercial-contact TODO is resolved or explicitly acknowledged pre-publish. Expect FAIL if 'open source' appears describing the project.
```ts
# expect: 'open source' present (FAIL) and no 'source-available' framing yet
```
```bash
grep -ni 'open source\|open-source' README.md LICENSING.md; grep -ci 'source-available\|converts to Apache' README.md
```

**Step 2 (run-fail):** Show any stray 'open source' describing Spacefolding and the untouched TODO(owner) line in LICENSING.md:29.
```bash
grep -ni 'open source' README.md LICENSING.md | head; grep -n 'TODO(owner)' LICENSING.md
```
Expected: If 'open source' appears describing Spacefolding itself, FAIL. LICENSING.md:29 TODO(owner) line present.

**Step 3 (implement):** (a) README.md license badge alt (line 2) already says 'converts to Apache-2.0 after 2 years' — keep it. Add ONE framing line under the hero: 'Source-available under FSL-1.1-ALv2 (free for internal, research, and non-competing use; commercial license for Competing Use; auto-converts to Apache-2.0 two years after each release). Modeled on sqlite-vec v0.1.0.' Never use 'open source' for the project. (b) README.md:237-242 keep the accurate paragraph but prepend 'Spacefolding is source-available (not open source) under...' and add the sqlite-vec v0.1.0 lineage note. (c) LICENSING.md:29 TODO(owner): if owner set a contact, fill it; if not, change to 'Commercial licensing contact is pending at first publish; until set, reach the copyright holder via the repository.' so the TODO is not silently shipped. Owner decision required at publish time.

**Step 4 (run-pass):** Confirm source-available framing present and no stray 'open source' describing the project.
```bash
grep -ci 'source-available' README.md; grep -ni 'open source' README.md | grep -vi 'apache' | head
```
Expected: First >=2 (source-available present); second empty (no stray 'open source'). PASS.

**Step 5 (verify-gate):** Run lint + full suite.
```bash
npm run lint && npm test 2>&1 | tail -3
```
Expected: lint clean; 503 tests passed.

**Step 6 (commit):** Commit with the exact message below.

**Commit:** `docs(license): frame FSL-1.1 as source-available (not open source), note 2y Apache conversion + sqlite-vec v0.1.0 lineage, resolve commercial-contact TODO`

**Risks:** Calling FSL 'open source' is a factual error (OSI does not approve FSL) and a publish-blocking correctness bug — this task prevents it. The sqlite-vec v0.1.0 modeling claim is per the approved design (Q4 positioning); keep as a one-line lineage note, not a comparison. LICENSING.md TODO resolution needs owner input — flag as a manual gate before the publish commit.

---

### Task Q4.4: Write the canonical honest-caveat block and pin it in README + CHANGELOG Unreleased

**Files:** Modify: README.md (new blockquote near benchmarks section). Modify: CHANGELOG.md:6 (Unreleased section, add 'Publish positioning' entry).

**Step 1 (write-failing-test):** Assert the honest-caveat block exists verbatim and is referenced from CHANGELOG. The caveat is load-bearing (FROZEN-CLAIM:9-23,76-94). Expect FAIL (no canonical block yet).
```ts
# expect FAIL: no canonical caveat block yet
```
```bash
grep -c 'No universal winner' README.md; grep -c 'collapses under the symbol-removed ablation' README.md
```

**Step 2 (run-fail):** Confirm the canonical block phrases are absent (task 2 may have added a mention; this task pins the full block).
```bash
grep -ci 'no universal winner' README.md
```
Expected: 0 (FAIL) if not yet added.

**Step 3 (implement):** Add this EXACT canonical block as a blockquote in README.md immediately after the benchmarks lead, and add a matching entry to CHANGELOG.md Unreleased. Blockquote copy: '> **Honest scope.** Spacefolding is not a universal retrieval winner. On commit-derived held-out tasks, a correctly-implemented BM25F beats it on top-1 (Hits@1) on django and rust. Its one durable, genuine edge is top-1 localization over FTS, which holds on django and typescript and FAILS on rust. That edge is exact-identifier matching, not learned semantics: it collapses under the symbol-removed ablation (django 0.875 to 0.524, typescript 0.604 to 0.320). The full claim, CIs, and the rust-exclusion reason live in benchmarks/FROZEN-CLAIM.md.' CHANGELOG.md Unreleased entry: '- **Launch positioning (D5).** README now leads with the durable top-1-localization edge (not grep efficiency), names context rot, states the local-first x invisible-plugin x structural+vector triple, frames the license as source-available FSL-1.1-ALv2 (converts to Apache-2.0 in 2y, modeled on sqlite-vec v0.1.0), and pins the honest no-universal-winner caveat. Taglines converged across README, CLAUDE.md, docs/index.md, package.json.'

**Step 4 (run-pass):** Confirm the caveat block and CHANGELOG entry are present.
```bash
grep -c 'No universal winner' README.md; grep -c 'Launch positioning (D5)' CHANGELOG.md
```
Expected: 1 (or more) and 1. PASS.

**Step 5 (verify-gate):** Run lint + full suite.
```bash
npm run lint && npm test 2>&1 | tail -3
```
Expected: lint clean; 503 tests passed.

**Step 6 (commit):** Commit with the exact message below.

**Commit:** `docs(positioning): pin canonical honest-caveat block in README + CHANGELOG Unreleased (D5)`

**Risks:** Caveat numbers MUST match FROZEN-CLAIM.md exactly (django 0.875->0.524, typescript 0.604->0.320). Do not paraphrase the ablation deltas. If FROZEN-CLAIM is ever re-frozen, this block must be updated in lockstep — note in commit body.

---

### Task Q4.5: Verify .mcp.json correctness for the published npx form (clean-install dry run)

**Files:** Verify: docs/integration-guide.md:32-41 (published npx .mcp.json). Verify: src/cli/commands/init.ts:44-60 (buildServerEntry npx form). Test: tests/init.test.ts (existing) — add/confirm a test that the npx form matches the published doc.

**Step 1 (write-failing-test):** Confirm there is an existing init.test.ts covering the npx .mcp.json shape; if it does not assert the EXACT published shape {command:'npx', args:['-y','spacefolding','serve']}, add that assertion. This guards the doc/code contract that the published package will be callable via npx -y spacefolding serve.
```bash
grep -n "npx\|'-y'\|spacefolding.*serve\|buildServerEntry" tests/init.test.ts
```

**Step 2 (run-fail):** If a new assertion was added, it FAILS first ('expected npx form ...'). If existing tests already cover it, PASS — then this step is confirm-only and the task collapses to a doc/code cross-check. Report honestly which.
```bash
npx vitest run tests/init.test.ts 2>&1 | tail -15
```
Expected: Either FAIL (new assertion) or PASS (already covered) — report honestly.

**Step 3 (implement):** If the assertion was missing, add it to init.test.ts: assert buildServerEntry('npx', ...) returns an object whose .command === 'npx' and .args equals ['-y','spacefolding','serve'] (matching docs/integration-guide.md:36-40). No production code change expected — init.ts:54-60 already produces this. If docs and code diverge, fix the DOC to match code (code is source of truth), not the code.

**Step 4 (run-pass):** Confirm init.test.ts green and the published .mcp.json shape is contract-tested.
```bash
npx vitest run tests/init.test.ts 2>&1 | tail -5
```
Expected: PASS — init.test.ts green.

**Step 5 (verify-gate):** Cross-check the doc snippet matches the contract exactly (whitespace-only diff).
```bash
grep -A6 'mcpServers' docs/integration-guide.md | head -8
```
Expected: Shows the npx form: command 'npx', args ['-y','spacefolding','serve']. If drifted, fix doc to match code.

**Step 6 (commit):** Commit with the exact message below (only if a test or doc actually changed).

**Commit:** `test(init): contract-test the published npx .mcp.json shape; reconcile docs/integration-guide.md to match`

**Risks:** The one task touching a test file (and possibly a doc). It does NOT touch retrieval/ranking, so no ablation gate is required for correctness — but run the blocking gate in task 7 as the publish regression guard. If doc and code already agree and tests already cover it, this task is confirm-only: report that and skip the commit (no no-op commits).

---

### Task Q4.6: Clean-install smoke: npm pack + fresh install + download default model + one-task retrieval reproducing T02 within the non-determinism band

**Files:** Verify (no edits): package.json files allowlist (19-33), dist build output, benchmarks/dataset.json T02. Run-and-observe task; output captured in the publish PR body.

**Step 1 (other):** Build and pack to confirm the published tarball contains exactly the allowlisted files (no stray src/test/benchmark leakage).
```bash
npm run build && npm pack --dry-run 2>&1 | grep -E 'npm notice.*[0-9]+\.[0-9]+ kB' | head -40
```
Expected: Tarball entries = only the package.json files allowlist: dist/, README.md, LICENSE, CHANGELOG.md, docs/(index|integration-guide|configuration).md, docs/logo*.svg, docs/{concepts,howto,reference,tutorials}/. NO src/, NO test files, NO benchmarks/. Report the file count.

**Step 2 (other):** Clean-install the packed tarball in a throwaway temp dir, download the default model Xenova/bge-small-en-v1.5. First run downloads ONNX weights; allow network.
```bash
rm -rf /tmp/sf-smoke && mkdir -p /tmp/sf-smoke && cd /tmp/sf-smoke && npm install $(ls /home/ben/Documents/Projects/spacefolding/spacefolding-*.tgz) 2>&1 | tail -3 && ./node_modules/.bin/spacefolding download-model 2>&1 | tail -5
```
Expected: Model downloads into the XDG cache. Exit 0.

**Step 3 (other):** Ingest the spacefolding repo itself into a per-project DB and run the T02 retrieval. T02 query = 'How does the scoring engine weight different factors?', relevant file src/core/scorer.ts (benchmarks/dataset.json).
```bash
cd /tmp/sf-smoke && DB_PATH=./data/sf.db ./node_modules/.bin/spacefolding ingest-project /home/ben/Documents/Projects/spacefolding 2>&1 | tail -3 && DB_PATH=./data/sf.db ./node_modules/.bin/spacefolding retrieve --query 'How does the scoring engine weight different factors?' --strategy structural --mode focused 2>&1 | grep -i 'scorer\|router\|rank\|file:' | head -10
```
Expected: src/core/scorer.ts (or src/core/router.ts) appears in top retrieved results. Deterministic provider = non-flaky band; ONNX local = minor jitter within published band. PASS: scorer.ts or router.ts in top 5.

**Step 4 (verify-gate):** If scorer.ts/router.ts appear in top results, the smoke reproduces a published result within the band. Capture the actual ranks in the publish PR body (honesty: do not claim a rank you did not observe).
Expected: scorer.ts or router.ts observed in top 5. Ranks recorded verbatim.

**Commit:** `(no commit — observation-only smoke; record result in publish PR body)`

**Risks:** Network needed to download the ONNX model on first run (~130MB) — if the publish environment is offline, pre-warm via spacefolding init first. The smoke is a SANITY check, not a benchmark: must not be reported as a quality claim. Deterministic provider is non-flaky; ONNX local embeddings have minor jitter — state which provider ran in the captured log. If scorer.ts does NOT appear in top 5, that is publish-blocking (investigate before publish, do not proceed to task 8).

---

### Task Q4.7: Re-run the frozen BLOCKING ablation gate as the publish regression guard + npm audit 0 critical/high gate

**Files:** Verify (no edits): .github/workflows/ci.yml:86-91 (gate command), benchmarks/check-acceptance.ts:55-69,628-634. Run both gates, capture PASS.

**Step 1 (verify-gate):** Re-run the exact CI blocking gate to prove no regression was introduced by the docs/test work (especially task 5 if it touched init code, which it should not). This is the design's honesty rule applied as a publish guard.
```bash
npm run build && BENCHMARK_RETRIEVAL_DEPTH=200 npx tsx benchmarks/evaluate.ts --corpus-snapshot benchmarks/fixtures/self-corpus.json --strategy all --json > /tmp/eval.json && npx tsx benchmarks/check-acceptance.ts --blocking-subset --retrieval-json /tmp/eval.json
```
Expected: Final line 'Acceptance gate: PASS'. Exit 0. If FAIL, publish is BLOCKED.

**Step 2 (verify-gate):** Run npm audit and confirm 0 critical, 0 high in production deps. This is the design's publish gate.
```bash
npm audit --omit=dev --audit-level=high 2>&1 | tail -10; echo "exit=$?"
```
Expected: 0 vulnerabilities at high+critical level (exit 0). If high/critical exist, publish BLOCKED — run npm audit fix or pin, then re-run. Report the actual count honestly.

**Step 3 (verify-gate):** Second confirmation of the audit headline number.
```bash
npm audit --omit=dev 2>&1 | grep -E 'vulnerabilities|critical|high' | head
```
Expected: Line like 'found 0 vulnerabilities'. Any critical/high count > 0 = BLOCKED.

**Step 4 (other):** If both gates PASS, record results (blocking-gate PASS + audit 0 critical/high + smoke from task 6) in CHANGELOG Unreleased / publish PR body. No commit needed if gates already green.
Expected: Both gates PASS recorded.

**Commit:** `(no commit — gate observations; record PASS in publish PR body)`

**Risks:** npm audit on better-sqlite3 / sqlite-vec native deps occasionally flags transitive issues that are dev-only or patched upstream — investigate before treating as blocking; gate is critical/high in production deps (--omit=dev). The blocking ablation gate is deterministic and non-flaky per FROZEN-CLAIM:86-93, so a FAIL is a real regression, not noise.

---

### Task Q4.8: npm publish (OWNER-GATED): confirm npm auth + owner go, then publish 0.1.0

**Files:** Verify (no edits): package.json:3 (version 0.1.0), package.json:6-9 (repository metadata), LICENSE (FSL-1.1-ALv2). This is the publish action itself.

**Step 1 (other):** Confirm npm authentication as the package owner. STOP if not authenticated or if owner has not explicitly said go. This task is the single point where owner consent is required.
```bash
npm whoami 2>&1
```
Expected: Prints the owner npm username. If 'npm ERR! code ENEEDAUTH', STOP and request owner to run npm login. Do NOT publish until whoami returns the intended owner AND the owner has said go.

**Step 2 (other):** Final pre-publish sanity: version is 0.1.0, name is free, files allowlist clean (re-confirm from task 6 dry-run), git working tree clean.
```bash
node -e "console.log(require('./package.json').version, require('./package.json').name)" && npm view spacefolding version 2>&1 | head -1 && git status --porcelain
```
Expected: Prints '0.1.0 spacefolding'; npm view returns E404 (still free); git status empty (all committed). If any fail, STOP.

**Step 3 (other):** Publish. Use npm publish (no --tag) for the first public release. The dist built in task 6/7 ships. Two-factor on the owner account will prompt.
```bash
npm publish 2>&1 | tail -15
```
Expected: Output includes '+ spacefolding@0.1.0' and the tarball SHA. Exit 0. If 2FA fails or name collision, STOP and resolve.

**Step 4 (verify-gate):** Confirm the package is now resolvable exactly as the published .mcp.json specifies (npx -y spacefolding serve). Closes the docs-to-npm contract loop.
```bash
npm view spacefolding version && cd /tmp && rm -rf sf-verify && mkdir sf-verify && cd sf-verify && timeout 60 npx -y spacefolding --help 2>&1 | head -5
```
Expected: npm view prints 0.1.0; npx -y spacefolding resolves and prints CLI help (proving bin + name + allowlist work for end users). Exit 0.

**Step 5 (commit):** Optional but recommended: tag the release. The FSL->Apache 2-year clock starts at release availability, so the tag date is load-bearing.
```bash
git tag v0.1.0 -m 'v0.1.0 — first public release (FSL-1.1-ALv2)' && git push origin v0.1.0
```
Expected: Tag created and pushed. Owner decides whether to tag.

**Commit:** `(publish action — no source commit; optional git tag v0.1.0)`

**Risks:** HIGHEST-RISK task: once published, 0.1.0 is permanent on npm (unpublish only within 72h and only if no installs). The 2-year FSL->Apache clock starts at this release's availability, so the date is legally load-bearing — record it. MUST be owner-gated explicitly. If task 6 smoke failed, task 7 gate failed, or task 7 audit has high/critical, DO NOT publish. After publish, update LICENSING.md commercial-contact line if owner set a contact (task 3 follow-up).

---
