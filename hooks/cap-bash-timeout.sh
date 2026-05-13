#!/usr/bin/env bash
# PreToolUse hook for the Bash tool.
#
# Why: the SDK's Bash tool only SIGKILLs the immediate child shell on timeout,
# so grandchildren (vitest workers, npm subprocesses) can survive and pin the
# tool call open indefinitely. We rewrite the command to run the inner work in
# its own process group via `set -m` and SIGKILL `-$pid` (the whole group)
# from a sibling watchdog. Exit 124 mirrors `timeout(1)`'s convention so the
# agent gets a recognisable timeout signal alongside the stderr explanation.
#
# This hook must run AFTER any hook that inspects `.tool_input.command` for
# patterns (e.g. block-dangerous-git.sh), because once we rewrite the command
# subsequent hooks would only see the wrapped form. The PreToolUse chain in
# agent-settings.json controls that ordering.
set -euo pipefail

readonly INPUT=$(cat)
readonly CAP_MS=180000

readonly COMMAND=$(jq -r '.tool_input.command // empty' <<<"$INPUT")
readonly REQUESTED=$(jq -r '.tool_input.timeout // empty' <<<"$INPUT")

# Malformed/empty input: emit a no-op decision rather than blocking by exiting
# non-zero. The SDK treats a non-zero hook exit as "deny tool call".
if [[ -z "$COMMAND" ]]; then
  jq '{hookSpecificOutput: {hookEventName: "PreToolUse"}}' <<<"$INPUT"
  exit 0
fi

if [[ -z "$REQUESTED" ]] || (( REQUESTED > CAP_MS )); then
  TIMEOUT_MS=$CAP_MS
else
  TIMEOUT_MS=$REQUESTED
fi
readonly TIMEOUT_MS
# Round up so a 1500ms request still gets a >=2s watchdog.
readonly TIMEOUT_S=$(( (TIMEOUT_MS + 999) / 1000 ))

# Base64-encode the agent's command so we never have to escape arbitrary shell
# into the wrapper. The base64 alphabet is shell-safe (no quoting needed).
readonly ENCODED=$(printf '%s' "$COMMAND" | base64 | tr -d '\n')

# We invoke `bash -c` explicitly because the SDK may select zsh as the
# persistent shell (it picks bash or zsh based on CLAUDE_CODE_SHELL / SHELL /
# discovery), and `set -m` is rejected in non-interactive zsh.
readonly INNER=$(cat <<EOF
set -m
eval "\$(echo $ENCODED | base64 -d)" &
pid=\$!
(
  sleep $TIMEOUT_S
  echo "[cap-bash-timeout] killed pgroup after ${TIMEOUT_S}s (limit=${TIMEOUT_MS}ms, cap=${CAP_MS}ms) -- enforced by hooks/cap-bash-timeout.sh because the SDK only SIGKILLs the immediate shell. Check for leaked file/socket/worker handles, watch processes, or unawaited backgrounded subshells in the command." >&2
  kill -KILL -\$pid 2>/dev/null
) &
wpid=\$!
wait \$pid
rc=\$?
# Watchdog gone => it fired => normalise rc to timeout(1)'s 124.
if ! kill -0 \$wpid 2>/dev/null; then
  rc=124
else
  kill \$wpid 2>/dev/null
fi
exit \$rc
EOF
)
readonly INNER_B64=$(printf '%s' "$INNER" | base64 | tr -d '\n')

# Outer command uses `bash -c "$(...)"` (works in both bash and zsh outer
# shells) and passes the decoded inner script as a single argument so the
# inner command's stdin isn't hijacked by the decoding pipe.
readonly WRAPPED="bash -c \"\$(echo $INNER_B64 | base64 -d)\""

jq --arg cmd "$WRAPPED" --argjson t "$TIMEOUT_MS" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", updatedInput: (.tool_input | .command = $cmd | .timeout = $t)}}' \
  <<<"$INPUT"
