#!/usr/bin/env bash
set -euo pipefail

readonly COMMAND=$(jq -r '.tool_input.command' < /dev/stdin)

# Any push is owned by the orchestrator, not the agent. Block every form.
readonly -a PUSH_PATTERNS=(
  "git push"
)

# Other destructive operations that can lose work.
readonly -a DESTRUCTIVE_PATTERNS=(
  "git reset --hard"
  "git clean -f"
  "git clean -fd"
  "git clean -fdx"
  "git checkout -- ."
  "git checkout ."
  "git restore ."
  "git branch -D"
  "git stash drop"
  "git stash clear"
)

block() {
  local kind="$1"
  cat >&2 <<EOF
BLOCKED ($kind): "$COMMAND"

This command is reserved for the HITL or is destructive in a way that loses work.
Do the actual work (edit, commit) and stop.
EOF
  exit 2
}

for pattern in "${PUSH_PATTERNS[@]}"; do
  if [[ "$COMMAND" == *"$pattern"* ]]; then
    block "push"
  fi
done

for pattern in "${DESTRUCTIVE_PATTERNS[@]}"; do
  if [[ "$COMMAND" == *"$pattern"* ]]; then
    block "destructive git operation"
  fi
done
