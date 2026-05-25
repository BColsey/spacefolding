# Next Conversation Plan

Status: local handoff note. The earlier dirty Ralph loop output has since been committed and progress trackers are in `REVIEW`. After the documentation cleanup, there are tracked documentation edits plus this untracked file; run `git status --short --branch` before taking action.

## Current Verified Checkpoint

- Branch: `main`
- Latest local commit: `b5ac5dd Harden CLI ingest symlink handling`
- Relation to remote: `main...origin/main [ahead 107]`
- Tracked worktree before documentation cleanup: clean
- Current local artifact: `NEXT_CONVERSATION_PLAN.md` is untracked unless intentionally added.
- Quality gate on 2026-05-25: `npm run build`, `npm run lint`, and `npm test` passed.
- Test count at that checkpoint: 28 files, 353 tests.
- Acceptance gate on 2026-05-25: passed all 13 checks using `/tmp/spacefolding-eval.json` and `/tmp/spacefolding-e2e.json`.
- Sandbox note: `npx tsx benchmarks/e2e-benchmark.ts` can fail inside the sandbox with `listen EPERM` on `/tmp/tsx-*`; rerun outside the sandbox or with approval before treating it as an application failure.

## Resume Checklist

If this file appears in a future handoff, first re-check the actual repo state instead of trusting the old loop notes:

```bash
git status --short --branch
git log --oneline -n 5
```

Run the standard quality gate after any tracked changes:

```bash
npm run build
npm run lint
npm test
```

Run the acceptance gate after retrieval, benchmark, or documentation snapshot changes:

```bash
npm run build
npx tsx benchmarks/evaluate.ts --strategy all --json > /tmp/spacefolding-eval.json
npx tsx benchmarks/e2e-benchmark.ts --strategy structural --json > /tmp/spacefolding-e2e.json
npx tsx benchmarks/check-acceptance.ts --retrieval-json /tmp/spacefolding-eval.json --e2e-json /tmp/spacefolding-e2e.json
```

## Ralph Runner Notes

```bash
./ralph-all.sh codex 7
RALPH_SLEEP_SECONDS=0 RALPH_MAX_ITERATIONS=1 ./ralph.sh measurement codex
```
