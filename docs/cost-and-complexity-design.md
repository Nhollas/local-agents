# Cost and Complexity Design

The current `workflow.yaml` runs the same `implement → review → summarise` sequence for every issue. The `implement` step's preamble asks the agent to orient on the repository, locate prior implementations, and read independently. That is the right behaviour for non-trivial feature work and the wrong behaviour for swapping a deprecated package. On a recent dependency bump we observed roughly eight minutes and around eighty thousand tokens spent on orientation alone, before the agent made a single edit. Across many runs against the same repository, none of that orientation is shared.

This document describes the changes we are making to address that.

## Goals

1. **One axis of variation, owned by the ticket.** The issue author declares the work's complexity, and the orchestrator picks behaviour from that label. There is no model-driven classifier in the loop.
2. **Same orchestrator surface, same workflow file.** The complexity decision routes between a small fixed set of profiles defined in `workflow.yaml`. The orchestrator's lifecycle pins, adapters, and run model stay unchanged.
3. **Stop rediscovering the same repository every run.** Static context, such as layout, conventions, and key entrypoints, should be cached across runs rather than re-derived per issue.
4. **Cut tokens on the steps where the spend is wasted, not on the steps where it earns its keep.** Trivial work skips orientation, standard work scopes once and trusts that scope, and deep work keeps the full exploratory shape.

## Out of scope

- Automated complexity classification, whether via a small model or a rules engine. The ticket author has the cheapest and most accurate signal.
- Replacing agent runs with codemods. Mechanical work continues to go through an agent.
- Per-repository workflow files. The orchestrator stays single-workflow, and variation happens inside `workflow.yaml`.

---

## Decisions

| Fork | Decision |
|---|---|
| Who decides complexity | The issue author, via a tracker label. |
| Number of complexity tiers | Three: `trivial`, `standard`, `deep`. |
| Default tier when no label is present | `standard`. |
| Profile selection mechanism | Tracker label `complexity:<tier>`, parsed alongside the existing `repo:<scope>/<name>` label. |
| Container shape for profiles in YAML | Single `workflow.yaml` with a `profiles:` map keyed by tier, each defining its own `steps:`. |
| Scoper output shape | `{ files: string[], approach: string }`. |
| Repository context source | The existing `CLAUDE.md` that the SDK injects via `settingSources`. |
| Cache granularity | Static prefix only: the role block and any workflow-specific guidance, with CLAUDE.md riding inside the system prompt. |
| How step content is shared across profiles | Inline per step, no partials. |
| Sub-agent delegation | The `Task` tool is enabled, and profile prompts steer agents towards delegating exploration to sub-agents so the parent context stays lean. |

---

## Proposal at a glance

```
Issue picked up
        │
        ▼
Read complexity label, choose profile
        │
        ├── trivial  ─→ [ implement (minimal) ] ───────────→ review (light) → summarise
        ├── standard ─→ [ scope → implement (scoped) ] ────→ review        → summarise
        └── deep     ─→ [ scope → implement (exploratory) ]→ review (full) → summarise
```

The lifecycle pins, namely `branch`, push, change request, and tracker transition, are unchanged.

---

## Complexity label

A single Jira label, parsed alongside the existing `repo:<scope>/<name>` label.

```
complexity:trivial    | complexity:standard | complexity:deep
```

| Tier | Use for | Anti-examples |
|---|---|---|
| `trivial` | Dependency-version bumps, single-import renames, configuration tweaks, documentation typos. The work is mechanical and the scope is obvious from the ticket itself. | Behavioural fixes, anything touching tests, anything cross-cutting. |
| `standard` | Single-feature work, bug fixes that need a modest amount of investigation, refactors limited to one or two files. This is the default when no label is set. | Architecturally novel work, multi-component refactors, anything where "what should this even look like" forms part of the task. |
| `deep` | Cross-cutting refactors, new subsystems, ambiguous specifications that need exploration before scoping is possible. | Mechanical work where the scope is already understood. |

If the label is absent, the run uses `standard`. If multiple `complexity:*` labels are present, the orchestrator fails the run early, because the labels are mutually exclusive.

---

## Profiles

Each profile defines its own `steps:` and each step's prompt is written inline, in the same style as today's `workflow.yaml`.

```yaml
profiles:
  trivial:
    steps:
      - name: implement
        prompt: |
          <role>
          You are an autonomous software engineer working a single issue
          end-to-end on branch `{{ branch }}`, cut from `{{ base_branch }}`.
          Commit your work as you go. Do not push or open a pull request.
          </role>

          <issue key="{{ issue.key }}" title="{{ issue.title }}">
          {{ issue.description }}
          </issue>

          The work is mechanical. Make the change described in the issue.
          Do not orient on the repository beyond reading the files the issue
          names. Run the project's checks before committing.

      - name: review
        prompt: |
          <role>
          Review the changes on branch `{{ branch }}` against `{{ base_branch }}`
          for correctness on the changed files only.
          </role>

          <diff base="origin/{{ base_branch }}" head="HEAD">
          !`git diff origin/{{ base_branch }}...HEAD`
          </diff>

      - name: summarise
        model: claude-haiku-4-5
        output_schema:
          type: object
          properties:
            title: { type: string }
            body: { type: string }
          required: [title, body]
        prompt: |
          Summarise the change on branch `{{ branch }}` for reviewers.

          <commits>
          !`git log origin/{{ base_branch }}..HEAD --oneline`
          </commits>

  standard:
    steps:
      - name: scope
        output_schema:
          type: object
          properties:
            files: { type: array, items: { type: string } }
            approach: { type: string }
          required: [files, approach]
        prompt: |
          <role>
          You are an autonomous software engineer scoping a single issue
          on branch `{{ branch }}`, cut from `{{ base_branch }}`.
          </role>

          <issue key="{{ issue.key }}" title="{{ issue.title }}">
          {{ issue.description }}
          </issue>

          Identify the files this change will touch and a one-paragraph
          approach. Use what is already in your system prompt about this
          repository's layout and conventions. Do not edit anything.

          For any non-trivial search or file-content investigation, delegate
          to a sub-agent via the Task tool rather than reading and grepping
          directly. Their summaries land in your context; their full
          investigation does not.

      - name: implement
        resume_previous: true
        prompt: |
          You produced a scope above. Implement the change now.

          Stay inside the scoped files where possible. Widen the scope and
          say so in your final message if reality demands it. Run the
          project's checks before committing.

      - name: review
        model: claude-opus-4-7
        prompt: |
          <role>
          Review the changes on branch `{{ branch }}` against `{{ base_branch }}`.
          </role>

          <diff base="origin/{{ base_branch }}" head="HEAD">
          !`git diff origin/{{ base_branch }}...HEAD`
          </diff>

      - name: summarise
        model: claude-haiku-4-5
        prompt: |
          ...  # same shape as the trivial summarise step.

  deep:
    steps:
      - name: scope
        prompt: |
          ...  # same shape as standard, with explicit licence to widen scope.
      - name: implement
        resume_previous: true
        prompt: |
          ...  # the full orientation-and-investigation prompt, equivalent
               # to today's implement step in workflow.yaml.
      - name: review
        model: claude-opus-4-7
        prompt: |
          ...  # today's review prompt verbatim.
      - name: summarise
        model: claude-haiku-4-5
        prompt: |
          ...  # same shape as the trivial summarise step.
```

Two things to call out from the sketch. First, the `implement` step under `standard` does not restate the role, because `resume_previous: true` means the agent already has it from the scope step's session. Second, the implementer does not splice `{{ steps.scope.output.files }}` into its prompt either, because the structured output the scoper produced is already in the resumed conversation history as the prior assistant message.

Where role boilerplate does recur across steps or across profiles, it is repeated rather than abstracted into a shared partial. The duplication is bounded, the existing workflow already inlines per step, and a partials mechanism would not meaningfully improve cache reuse: the dominant cached content is the system prompt, which is identical across profiles regardless.

---

## Repository context

The Claude Agent SDK loads the project's `CLAUDE.md` into the system prompt by default, via the `settingSources` option which defaults to `['user', 'project']`. We currently rely on this default, so CLAUDE.md is already in the system prompt of every step we run, with no plumbing change required.

We pin `settingSources` to `['project']` explicitly in `server/orchestrator/agent-invoker.ts`. This documents the dependency rather than leaving us at the mercy of an SDK default, and it keeps the user-level `~/.claude/CLAUDE.md` out of the system prompt, which is desirable because the orchestrator runs agents on behalf of many repositories.

Two consequences of CLAUDE.md living in the system prompt:

- Each workflow step inherits the repository's conventions and orientation guidance without us needing a partial or a separate template variable.
- The static prefix structure described in the prompt-caching section already includes CLAUDE.md, because the SDK places it ahead of any user message.

We also drop the orientation instruction from the current `implement` step's preamble. Today it tells the agent to "Read what this repo provides for orientation — agent instructions, READMEs, contributing/standards docs, ADRs" as tool calls. Because CLAUDE.md is already in the agent's system prompt by the time that instruction runs, the agent obeys by spending Read calls on content it has been handed for free. The new profile prompts omit the instruction entirely.

---

## Prompt caching

Anthropic's prompt cache stores the prefix of a prompt and serves it back at a roughly 90% discount on input tokens when the same prefix is sent again within the cache window. Cache reads cost approximately 10% of base input; writes cost 1.25× for the 5-minute TTL. The cache key is the full prefix up to the breakpoint, so stable ordering across runs is essential.

The win for this orchestrator is twofold:

1. **Within a run, across steps.** Each step is its own `query()` call today, yet every step's prompt sits on top of a large shared static prefix: the system prompt (with CLAUDE.md inside it), the tool definitions, and the role block at the top of the step prompt. If we structure step prompts so the static role block comes first and the dynamic content (issue, diff, prior step output) comes last, every step after the first hits the cache on the prefix.
2. **Across concurrent runs on the same repository.** Two issues dispatched against the same repository within five minutes share the system prompt and any identical role block. With `max_concurrent: 2` this is the common case.

What this implies for the workflow:

- The rendering layer emits a stable prefix. Static content (the role block, and any workflow-specific guidance that does not change run-to-run) lands first and is identical across steps, with dynamic content (issue, branch, diff, prior step outputs, shell-expanded blocks) appended afterwards.
- Shell-block expansions such as `` !`ls -1` `` and `` !`git log` `` are inherently dynamic, so they belong in the dynamic suffix. The `<repo_layout>` shell block in today's `implement` prompt is removed, because CLAUDE.md covers the same ground statelessly.
- The workflow engine's SDK adapter applies `cache_control` to the static block when calling the SDK.

### Inheriting the cache via `resume_previous`

The workflow YAML already exposes `resume_previous: true` as a step-level option that continues the previous step's Claude session rather than starting fresh. Profiles use this to express scope-to-implement continuity. The orchestrator has no hardcoded knowledge that `implement` follows `scope`; the profile declares the connection, and the engine honours it.

Because the resumed session shares its system prompt and tool definitions with the prior step, its first query hits the same cached prefix at read rates rather than write rates. The implementer also inherits the scoper's reasoning history as conversational context.

The `standard` and `deep` profiles both set `resume_previous: true` on the `implement` step. The `trivial` profile has a single non-summarise step, so the option does not apply.

---

## Two-pass scoper → implementer

The scoper is a deliberately small prompt: issue, CLAUDE.md (via the system prompt), and "name the files and the approach". The output is structured against a JSON schema. The implementer then runs with `resume_previous: true` and is instructed to stay inside the scoped files where possible.

- The scoper benefits fully from the cached prefix and runs cheaply.
- The implementer's most expensive failure mode today is unbounded exploration. A concrete file list bounds it.
- The structured output gives the dashboard something concrete to surface: the agent's view of which files the change should touch, visible before the implementer commits anything.

The risk we accept is that the scoper occasionally picks the wrong files and the implementer is too obedient to push back. We mitigate this by allowing the implementer to widen scope while requiring it to flag the change in its final message.

The `deep` profile uses the same scope step, but instructs the implementer to treat the scope as a starting point rather than a fence. The `deep` implementer is also instructed to delegate any further investigation beyond the scoped files to sub-agents.

---

## Sub-agent delegation

The Claude Agent SDK exposes a `Task` tool that lets the agent spawn sub-agents. A sub-agent runs in its own context window, executes to completion, and returns a single summary message to the caller. The caller's context only ever sees that summary, not the sub-agent's reads, greps, or intermediate reasoning.

This is the right primitive for exploration-heavy work, because it lets the main agent ask "what does this module do?" or "find every caller of X" and get back a paragraph rather than dragging the full investigation into its own context. It also keeps the cached prefix stable: however much investigation a sub-agent does under the hood, the parent's prompt is unaffected.

`Task` is not currently in `ALLOWED_TOOLS` in `server/orchestrator/agent-invoker.ts`. We add it. Profile prompts then steer agents towards delegating:

- The `scope` step in `standard` and `deep` delegates file searches and content investigations, so the scoper's own context stays small enough that its full transcript fits comfortably inside the cache budget.
- The `implement` step in `deep` delegates any investigation that goes beyond the scoped files. The implementer keeps editing in its own session; only the exploratory work is offloaded.
- The `trivial` profile has no exploration phase, but `Task` remains enabled for consistency.

---

## Shell-block output truncation

Today, `server/workflow/prompt-preprocessor.ts` runs each `` !`...` `` block with a hard 1 MB output cap and a 30 second timeout. If a block exceeds the cap the run is failed. There is no truncation, no disk spill, no head and tail preview. Outputs under 1 MB are spliced into the prompt verbatim.

We change this to:

- Cap shell-block stdout at a configurable soft byte limit. The existing 1 MB cap becomes the hard ceiling beyond which we still fail rather than truncate.
- When a block exceeds the soft cap but falls under the hard ceiling, write the full output to a file under the workspace and replace the block content with a head section, a marker, a tail section, and the path on disk.
- The prompt continues to render exactly as it does today; the truncation is invisible to the workflow author.
- The agent has full read access to the workspace, so reading the truncated file when it needs the middle is a normal operation.

---

## Per-step model routing

Steps already support a per-step `model:` override. We use it deliberately:

- `summarise` runs on Haiku in every profile. The output is straightforward prose with no architectural judgement required.
- `scope` stays on Sonnet. It reads CLAUDE.md and picks the right files, which is exactly the kind of judgement the cheaper tier degrades on.
- `implement` stays on Sonnet across all profiles.
- `review` runs on Opus in `standard` and `deep`. The `trivial` review stays on Sonnet, because the diff is small and mechanical.

---

## Step-level cost knobs at a glance

Every step caches the system prompt, which includes the SDK-injected CLAUDE.md, together with the role block. The "Session" column shows which steps use `resume_previous` to continue the prior step's session and inherit its cached prefix.

| Profile  | Step       | Model    | Session             | Truncation |
|----------|------------|----------|---------------------|------------|
| trivial  | implement  | Sonnet   | fresh               | on |
| trivial  | review     | Sonnet   | fresh               | on |
| trivial  | summarise  | Haiku    | fresh               | on |
| standard | scope      | Sonnet   | fresh               | on |
| standard | implement  | Sonnet   | `resume_previous`   | on |
| standard | review     | Opus     | fresh               | on |
| standard | summarise  | Haiku    | fresh               | on |
| deep     | scope      | Sonnet   | fresh               | on |
| deep     | implement  | Sonnet   | `resume_previous`   | on |
| deep     | review     | Opus     | fresh               | on |
| deep     | summarise  | Haiku    | fresh               | on |

---

## What stays the same

- The orchestrator loop, lifecycle pins, and adapter shape.
- `branch:` as a first-class field; ADR 0001 is unaffected.
- The change-request template and its variables.
- The run repository schema, modulo any per-step token and cost accounting we already plan to introduce for the dashboard.
- `.agent/setup.sh` as repository-side bootstrap.

## What this proposal adds

- A `profiles:` block in `workflow.yaml` keyed by tier, with each profile defining its own `steps:` inline. No partials mechanism; each step's prompt is written in full in the same style as today's `workflow.yaml`.
- A complexity-label parser alongside the existing repository-label parser, with strict mutual-exclusion validation.
- A one-line change in `server/orchestrator/agent-invoker.ts` to pin `settingSources: ['project']`.
- `Task` added to `ALLOWED_TOOLS` in `server/orchestrator/agent-invoker.ts`, enabling sub-agent delegation.
- A prompt edit on the `implement` step's preamble, dropping the orient-on-the-repo instruction.
- `cache_control` wiring in the workflow engine's SDK adapter, together with a prompt structure that places stable content first.
- Use of the existing `resume_previous` workflow option on the `implement` step in the `standard` and `deep` profiles.
- A soft-cap truncation layer in the shell-block executor, including disk spill and a head and tail preview.
- A per-step `model:` override for the `summarise` step routing it to Haiku, and for the `review` step in `standard` and `deep` routing it to Opus.
