---
name: implement
description: Work a single issue end-to-end on the current branch. Orient until you can predict the change, write a plan, execute the smallest change that resolves the issue, verify with the project's checks, and commit as you go. Defers to the tdd skill when the issue calls for test-first work or when the issue is a bug fix with a sensible test seam. Use when implementing an AFK issue, picking up a tracer-bullet ticket, or whenever the user asks to "implement the issue" / "work this ticket".
---

# Implement

You are working a single issue end-to-end on the current branch. Commit your work as you go.

## Process

### 1. Orient until you can predict the change

Use what's already in your context first. Read the issue body carefully. Then pull in only what you need to make the change correctly:

- READMEs, ADRs, conventions docs in the area you'll touch.
- The existing implementation and tests for what you're changing.

Read independent files in parallel.

If the issue's scope is genuinely unclear and you'd otherwise spend a long time exploring, spawn an `Explore` sub-agent with a tight question ("where is X defined and who calls it?"). Don't use it for trivial lookups — direct reads are faster.

**Stop reading when you can name the files you'll touch and the approach you'll take.** Over-reading bloats context and hurts the change you're about to make.

### 2. Decide whether to use TDD

Use the **tdd** skill when either is true:

- The issue describes test-first work or names automated tests as part of what to deliver.
- The issue is a bug fix and the bug has a sensible test seam (a place where a failing repro test naturally lives).

If either applies, load the tdd skill now via the `Skill` tool (`skill: "tdd"`) and follow its red-green-refactor loop for the rest of this issue.

Otherwise, implement without forcing a test-first loop, and match the project's existing testing patterns when you add or update tests.

### 3. Write the plan

Before editing anything, write a short plan inside your reasoning:

- The files you'll touch and what changes in each.
- The behaviour you expect to add/change.
- How you'll verify it.

The plan is a checkpoint against rambling, not an artefact. It does not need to be committed or posted.

### 4. Make the smallest change that resolves the issue

Match the existing complexity in the codebase. Do not add:

- Abstractions the issue did not ask for.
- Defensive validation for scenarios that cannot happen.
- Configurability "in case we need it later".
- Backwards-compatibility shims, migration paths, or dual-read code unless the target repo's docs explicitly say to preserve compatibility.

Three similar lines is better than a premature abstraction.

### 5. Verify with the project's checks

Discover the commands from the repo (`package.json`, `Makefile`, `justfile`, repo READMEs). Run independent commands in parallel where you can. Common shape:

- A typecheck (`pnpm typecheck`, `tsc --noEmit`, `mypy`, …).
- A test command (`pnpm test`, `vitest run`, `pytest`, …).
- A linter only if the repo treats lint as part of CI; format-only tools can be skipped.

If a check fails, fix the cause. Do **not** silence the check (no `--no-verify`, no skipped tests, no commented-out assertions) unless the issue explicitly authorises it.

### 6. Commit as you go

Match the repo's commit-message convention (read recent `git log`). Keep commits focused — one logical change per commit. The final commit set is what the reviewer will read.

## Anti-patterns

- **Horizontal slicing.** Don't write all the code for layer A, then all the code for layer B. Land one vertical slice end-to-end and verify it, then the next. See the `tdd` skill for the disciplined version of this.
- **Speculative scope.** If you find adjacent issues while implementing, note them in your final message. Do not fix them here.
- **Silent skipping.** If a check is broken in a way you can't fix in scope, say so explicitly in your final message rather than skipping it quietly.

## Stopping

If the issue is blocked or under-specified, stop without committing speculative work. Leave a final message describing what you found, what you tried, and what's missing.

Delete temporary scratch files before stopping.
