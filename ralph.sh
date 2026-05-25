#!/usr/bin/env bash
set -u -o pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./ralph.sh [loop_name] [agent]

Arguments:
  loop_name   Optional. "-" or omitted uses PROMPT.md.
              Any other value uses PROMPT-{loop_name}.md.
  agent       Optional. "claude" is default. Supported: claude, codex.

Environment:
  RALPH_AGENT_CMD   Full agent command override. The command must read a prompt
                    from stdin and run one autonomous iteration.
  RALPH_SLEEP_SECONDS
                    Optional delay between successful iterations, in seconds.
                    Example: 3600 waits one hour between agent calls.
  RALPH_MAX_ITERATIONS
                    Optional maximum number of successful iterations to run.
                    Example: 5 runs five rounds, then exits.
  RALPH_CODEX_MODEL
                    Optional Codex model override. Example: gpt-5.5.
  RALPH_CODEX_REASONING_EFFORT
                    Optional Codex reasoning effort override. Example: xhigh.

Examples:
  ./ralph.sh
  ./ralph.sh - codex
  ./ralph.sh retrieval-ranking
  ./ralph.sh retrieval-ranking codex
  RALPH_SLEEP_SECONDS=3600 ./ralph.sh retrieval-ranking codex
  RALPH_MAX_ITERATIONS=5 ./ralph.sh retrieval-ranking codex
  RALPH_CODEX_MODEL=gpt-5.5 RALPH_CODEX_REASONING_EFFORT=xhigh ./ralph.sh retrieval-ranking codex
  RALPH_AGENT_CMD="custom-cli --flags" ./ralph.sh retrieval-ranking
USAGE
}

die() {
  printf 'ralph: %s\n' "$*" >&2
  exit 1
}

loop_name="${1:-}"
agent="${2:-claude}"

if [[ "${loop_name}" == "-h" || "${loop_name}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -z "${loop_name}" || "${loop_name}" == "-" ]]; then
  prompt_file="PROMPT.md"
  loop_label="main"
else
  prompt_file="PROMPT-${loop_name}.md"
  loop_label="${loop_name}"
fi

[[ -f "${prompt_file}" ]] || die "missing ${prompt_file}"

if [[ -n "${RALPH_AGENT_CMD:-}" ]]; then
  agent_cmd="${RALPH_AGENT_CMD}"
else
  case "${agent}" in
    claude)
      if [[ -x "${HOME}/.claude/local/claude" ]]; then
        agent_cmd="${HOME}/.claude/local/claude -p --dangerously-skip-permissions"
      elif command -v claude >/dev/null 2>&1; then
        agent_cmd="claude -p --dangerously-skip-permissions"
      else
        die "claude agent not found; set RALPH_AGENT_CMD or install claude"
      fi
      ;;
    codex)
      if command -v codex >/dev/null 2>&1; then
        agent_cmd="codex exec --dangerously-bypass-approvals-and-sandbox"
        if [[ -n "${RALPH_CODEX_MODEL:-}" ]]; then
          [[ "${RALPH_CODEX_MODEL}" =~ ^[A-Za-z0-9._:-]+$ ]] || die "RALPH_CODEX_MODEL contains unsupported shell characters"
          agent_cmd="${agent_cmd} --model ${RALPH_CODEX_MODEL}"
        fi
        if [[ -n "${RALPH_CODEX_REASONING_EFFORT:-}" ]]; then
          [[ "${RALPH_CODEX_REASONING_EFFORT}" =~ ^[A-Za-z0-9._:-]+$ ]] || die "RALPH_CODEX_REASONING_EFFORT contains unsupported shell characters"
          agent_cmd="${agent_cmd} -c model_reasoning_effort=${RALPH_CODEX_REASONING_EFFORT}"
        fi
        agent_cmd="${agent_cmd} -"
      else
        die "codex agent not found; set RALPH_AGENT_CMD or install codex"
      fi
      ;;
    *)
      die "unknown agent '${agent}'"
      ;;
  esac
fi

log_file="ralph-${loop_label}.log"
sleep_seconds="${RALPH_SLEEP_SECONDS:-0}"
max_iterations="${RALPH_MAX_ITERATIONS:-0}"
stop_after_current=0
running_pid=""

if [[ ! "${sleep_seconds}" =~ ^[0-9]+$ ]]; then
  die "RALPH_SLEEP_SECONDS must be a non-negative integer number of seconds"
fi

if [[ ! "${max_iterations}" =~ ^[0-9]+$ ]]; then
  die "RALPH_MAX_ITERATIONS must be a non-negative integer number of iterations"
fi

handle_interrupt() {
  if [[ "${stop_after_current}" -eq 0 ]]; then
    stop_after_current=1
    printf '\nralph: interrupt received; stopping after current iteration. Press Ctrl+C again to kill now.\n' >&2
    return
  fi

  printf '\nralph: second interrupt received; terminating current agent process.\n' >&2
  if [[ -n "${running_pid}" ]]; then
    kill -TERM "-${running_pid}" 2>/dev/null || kill -TERM "${running_pid}" 2>/dev/null || true
  fi
  exit 130
}

trap handle_interrupt INT

printf 'ralph: loop=%s prompt=%s agent=%s log=%s sleep_seconds=%s max_iterations=%s\n' "${loop_label}" "${prompt_file}" "${agent}" "${log_file}" "${sleep_seconds}" "${max_iterations}"
printf 'ralph: press Ctrl+C once to stop after the current iteration; twice to kill immediately.\n'

iteration=1
while true; do
  if [[ "${max_iterations}" -gt 0 && "${iteration}" -gt "${max_iterations}" ]]; then
    printf 'ralph: reached max iterations (%s); exiting\n' "${max_iterations}"
    exit 0
  fi

  if [[ "${stop_after_current}" -eq 1 ]]; then
    printf 'ralph: stopped before iteration %s\n' "${iteration}"
    exit 0
  fi

  {
    printf '\n===== %s iteration %s started at %s =====\n' "${loop_label}" "${iteration}" "$(date -Is)"
  } >>"${log_file}"

  # Run each iteration in its own process group so a second Ctrl+C can terminate
  # the agent and any children without killing this wrapper first.
  setsid bash -lc "${agent_cmd}" <"${prompt_file}" >>"${log_file}" 2>&1 &
  running_pid=$!

  wait_status=0
  wait "${running_pid}" || wait_status=$?
  running_pid=""

  {
    printf '===== %s iteration %s finished at %s with status %s =====\n' "${loop_label}" "${iteration}" "$(date -Is)" "${wait_status}"
  } >>"${log_file}"

  if [[ "${wait_status}" -ne 0 ]]; then
    printf 'ralph: iteration %s failed with status %s; see %s\n' "${iteration}" "${wait_status}" "${log_file}" >&2
    exit "${wait_status}"
  fi

  printf 'ralph: iteration %s complete; see %s\n' "${iteration}" "${log_file}"
  iteration=$((iteration + 1))

  if [[
    "${sleep_seconds}" -gt 0
    && "${stop_after_current}" -eq 0
    && ( "${max_iterations}" -eq 0 || "${iteration}" -le "${max_iterations}" )
  ]]; then
    printf 'ralph: sleeping %s seconds before iteration %s\n' "${sleep_seconds}" "${iteration}"
    sleep "${sleep_seconds}" || true
  fi
done
