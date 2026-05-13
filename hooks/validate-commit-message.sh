#!/usr/bin/env bash
set -euo pipefail

readonly COMMAND=$(jq -r '.tool_input.command' < /dev/stdin)

# Only care about git commit with -m flag
case "$COMMAND" in
  *"git commit"*"-m"*) ;;
  *) exit 0 ;;
esac

# Skip amend commits — they may reuse an existing message
[[ "$COMMAND" == *"--amend"* ]] && exit 0

# Extract the first line of the commit message
FIRST_LINE=""

if [[ "$COMMAND" == *'<<'* ]]; then
  # HEREDOC format: first non-blank line between EOF markers
  FIRST_LINE=$(printf '%s\n' "$COMMAND" | sed -n "/<<.*EOF/,/^[[:space:]]*EOF/{
    /<<.*EOF/d
    /^[[:space:]]*EOF/d
    /^[[:space:]]*$/d
    p
  }" | head -1 | sed 's/^[[:space:]]*//')
else
  # Inline format: content between quotes after -m
  FIRST_LINE=$(printf '%s\n' "$COMMAND" | sed -n 's/.*-m "\([^"]*\).*/\1/p' | head -1)
  if [[ -z "$FIRST_LINE" ]]; then
    FIRST_LINE=$(printf '%s\n' "$COMMAND" | sed -n "s/.*-m '\([^']*\).*/\1/p" | head -1)
  fi
fi

# If we couldn't extract a message, let it through (editor commit, -F, etc.)
[[ -z "$FIRST_LINE" ]] && exit 0

# Validate conventional commit format: type(optional-scope): description
readonly PATTERN='^(feat|fix|chore|docs|refactor|test|ci|perf|build|style|revert)(\([a-zA-Z0-9._-]+\))?!?: .+'

if ! [[ "$FIRST_LINE" =~ $PATTERN ]]; then
  cat >&2 <<EOF
BLOCKED: Commit message does not follow Conventional Commits format.

  Got: "$FIRST_LINE"

Expected: <type>(<optional scope>): <description>
Types: feat, fix, chore, docs, refactor, test, ci, perf, build, style, revert
Examples:
  feat: add user authentication
  fix(api): handle null response body
  docs: update README with setup instructions
EOF
  exit 2
fi
