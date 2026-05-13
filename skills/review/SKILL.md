---
name: review
description: Two-axis review of the work on the current branch against its base. The Standards axis checks the diff against this repo's documented coding/testing standards. The Spec axis checks the diff against the originating issue. Both axes run as parallel sub-agents so they don't pollute each other's context. Use when reviewing a branch produced by an AFK agent run, refining the diff before opening a change request, or whenever the user asks to "review the changes" / "review this branch".
---

# Review

Two-axis review of the diff between `HEAD` and its base branch:

- **Standards** — does the code conform to this repo's documented standards?
- **Spec** — does the code faithfully implement the originating issue?

Both axes run as **parallel sub-agents** so they don't pollute each other's context. This skill aggregates the findings and applies the fixes it considers in-scope.

This is review-as-refinement: surface every issue, then fix what matters on this branch. "Looks good" is a valid outcome — make no changes if the branch is already right.

## Process

### 1. Pin the diff

The diff command to hand to the sub-agents:

```
git diff origin/<base>...HEAD
```

Three-dot, so the comparison is against the merge-base. The sub-agents will run this themselves (or narrower variants of it) against the specific files they need.

### 2. Identify the standards sources

Anything in the repo that documents how code should be written. Common locations:

- `CLAUDE.md`, `AGENTS.md`
- `CONTRIBUTING.md`
- `docs/coding-standards.md`, `docs/testing-standards.md`, `docs/architecture.md`
- `docs/adr/` — architectural decisions are standards

Collect the list. The Standards sub-agent will read them.

### 3. Spawn both sub-agents in parallel

Send a single message with two `Agent` tool calls. Use the `general-purpose` subagent for both.

**Standards sub-agent prompt** — include:

- The diff command and commit list.
- The list of standards files from step 2.
- The brief: "Read the standards docs. Then read the diff. Report — per file/hunk where relevant — every place the diff violates a documented standard. Cite the standard (file + the rule). Distinguish hard violations from judgement calls. Skip anything tooling enforces. Under 400 words."

**Spec sub-agent prompt** — include:

- The diff command and commit list.
- The issue body verbatim.
- The brief: "Read the issue. Then read the diff. Report: (a) requirements the issue asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the issue line for each finding. Under 400 words."

### 4. Decide what to fix

Stay scoped to this issue. Fix anything that affects:

- correctness
- behaviour matching the issue
- tests for the change
- fit with project conventions

Note pre-existing problems unrelated to this change in your final message and leave them as-is. It is better to surface a finding and decide it doesn't need fixing than to silently drop a real bug.

### 5. Apply fixes and verify

Apply fixes directly on the branch, one focused commit per logical refinement. After fixing, re-run the project's typecheck and test commands — discover them from the repo (`package.json`, `Makefile`, `justfile`, READMEs). If a check cannot run, say so in your final message.

### 6. Report

Use this exact shape — three top-level sections, in this order, no other top-level headings:

```
## Standards

<verbatim Standards sub-agent report, or "No standards sources found." if step 2 turned up nothing>

## Spec

<verbatim Spec sub-agent report>

## Summary

- Standards: <N> findings — <M> fixed, <K> left
- Spec: <N> findings — <M> fixed, <K> left
- Checks: <typecheck: pass|fail|skipped>, <tests: pass|fail|skipped>, …
- Outcome: <changes-applied | no-changes>
```

Rules:

- Paste the sub-agent reports verbatim. Do **not** merge, rerank, or summarise across the two axes — they are deliberately separate so a human reviewer can see them independently.
- The Summary counts must reconcile with the reports above: every finding is either fixed in this branch or listed as left.
- "Left" findings should be ones you deliberately scoped out (pre-existing, out of scope for this issue, or judgement calls you rejected). Name them in the relevant axis report so a human can re-litigate.
- `Outcome: no-changes` is valid and expected when the branch is already right.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.

## Stopping

- If the branch needs no changes, make none. End with "no changes" plus the two reports.
- Do **not** restructure code beyond what the findings call for.
