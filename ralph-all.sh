#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./ralph-all.sh [agent] [iterations_per_loop]

Runs all Ralph loop prompts in sequence with zero delay between iterations.

Defaults:
  agent                codex
  iterations_per_loop  7
  loops                measurement retrieval-ranking indexing-chunking integration-polish

Environment:
  RALPH_LOOPS
      Space-separated loop list to run instead of the default sequence.

  RALPH_ITERATIONS_PER_LOOP
      Iterations to run for each loop. Defaults to 7, one full review-category
      cycle. The second positional argument overrides this value.

  RALPH_AGENT_CMD, RALPH_CODEX_MODEL, RALPH_CODEX_REASONING_EFFORT
      Passed through to ralph.sh.

Examples:
  ./ralph-all.sh
  ./ralph-all.sh codex 7
  ./ralph-all.sh claude 1
  RALPH_LOOPS="retrieval-ranking integration-polish" ./ralph-all.sh codex 7
USAGE
}

die() {
  printf 'ralph-all: %s\n' "$*" >&2
  exit 1
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

agent="${1:-codex}"
iterations_per_loop="${2:-${RALPH_ITERATIONS_PER_LOOP:-7}}"
loops="${RALPH_LOOPS:-measurement retrieval-ranking indexing-chunking integration-polish}"

[[ "${iterations_per_loop}" =~ ^[1-9][0-9]*$ ]] || die "iterations_per_loop must be a positive integer"
[[ -x "./ralph.sh" ]] || die "missing executable ./ralph.sh"

printf 'ralph-all: agent=%s iterations_per_loop=%s sleep_seconds=0\n' "${agent}" "${iterations_per_loop}"
printf 'ralph-all: loops=%s\n' "${loops}"

for loop in ${loops}; do
  prompt_file="PROMPT-${loop}.md"
  [[ -f "${prompt_file}" ]] || die "missing ${prompt_file}"

  printf '\nralph-all: starting loop %s\n' "${loop}"
  RALPH_SLEEP_SECONDS=0 \
  RALPH_MAX_ITERATIONS="${iterations_per_loop}" \
    ./ralph.sh "${loop}" "${agent}"
  printf 'ralph-all: finished loop %s\n' "${loop}"
done

printf '\nralph-all: all loops finished\n'
