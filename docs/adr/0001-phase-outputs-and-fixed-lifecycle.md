# Step outputs are data; orchestrator owns lifecycle at fixed timings; branch is a first-class field

- **Status:** Accepted
- **Date:** 2026-05-05

> In the context of *running multi-step agent workflows across many repos*, facing *the question of when lifecycle actions (branch, push, change-request, tracker transition) should fire relative to step outputs*, we decided for *fixed orchestrator-owned lifecycle pins with step outputs as pure typed data, and `branch:` lifted to a first-class workflow field*, to achieve *a small workflow surface and platform-agnostic orchestration*, accepting *that anything needing dynamic action timing must be handled by a deliberate successor ADR*.

## Context

The orchestrator drives multi-step agent workflows that clone a repo, run steps, commit work, and open a change request against a tracker. Steps produce structured outputs that flow into later step prompts and into change-request templates. Several lifecycle actions need to happen around the steps, including branch creation, pushes, opening the change request, and transitioning the tracker ticket. The open question is how their timing should relate to step execution.

One field is structurally special. The branch must exist before any step that writes commits, so the timing of `branch:` is constrained by the mechanics of git rather than by author intent. Every other lifecycle action could in principle be sequenced freely.

The same workflow file is meant to drive runs across many target repos with different package managers and bootstrap requirements, including pnpm, yarn, codegen warm-ups, and similar setup tasks.

## Decision drivers

- Workflow files must stay repo-agnostic so that one workflow can target many repos.
- Platform-abstraction goal: `TrackerAdapter` and `CodeHostAdapter` cover GitHub, GitLab, and Jira, with the orchestrator validating and auditing rather than the LLM running `git` or `gh` directly.
- Keep the workflow YAML surface small and the mental model flat.
- Preserve orchestrator hooks for retry, rollback, and audit.

## Decision

The orchestrator runs lifecycle actions at fixed pins. Step outputs are pure typed data: they flow into later step prompts and into `change_request` templates, but they never reorder when the orchestrator does anything.

Because `branch:` is the only field whose action timing is structurally constrained, it is lifted out of the step-output mechanism entirely and becomes a first-class workflow field. It can be either a static template or a dedicated branch-naming agent, and both forms run at clone-time.

Repo-specific bootstrap, such as `pnpm install` or codegen warm-ups, is owned by the target repo rather than by the workflow. The orchestrator runs `.agent/setup.sh` from the cloned repo if one is present.

## Considered alternatives

- **Inferred timing from output references**: the orchestrator schedules each action right after the step that produces its referenced field. Rejected because the only field where action timing is structurally constrained is `branch:`, and building a generic dependency-graph scheduler to handle a single structural case adds complexity that one use case does not justify.
- **Explicit lifecycle pins in YAML**: the workflow author interleaves `lifecycle: create_branch` lines between steps. Rejected because that introduces a small DSL with its own rules, such as "create_branch must precede any step that writes files", and adds YAML surface for no UX gain over the first-class `branch:` field.
- **End-of-run-only branching**: clone, run all steps on `base_branch`, then branch, commit, and push at the end. Rejected because steps would run with `git status` showing them on `main`, which is surprising mid-run, and because the model is incompatible with workflows that want intermediate commits visible on the agent's branch.
- **Sandcastle-style "agent owns git and gh"**: the orchestrator becomes thin glue while the LLM runs `git checkout`, `git push`, and `gh pr create`. Rejected because that conflicts with the platform-abstraction goal, gives up validation and audit, and removes the retry and rollback hooks the orchestrator depends on.
- **Workflow-level `setup:` block**: the bootstrap script lives in `workflow.yaml`. Rejected because the same workflow runs across many repos with different package managers. Putting setup in the workflow either forces one workflow per repo or pushes a brittle "if pnpm-lock else if yarn.lock" ladder into the config. Cursor (`.cursor/environment.json`), GitHub Copilot coding agent (`copilot-setup-steps.yml`), and OpenHands (`AGENTS.md`) all put bootstrap in the target repo for the same reason.

## Consequences

- The workflow file's surface stays small, with `branch`, `change_request.{title,body,labels,draft}`, and `steps[]` as the three user-facing concepts.
- Repo-specific bootstrap becomes the repo author's responsibility. It is defined once in `.agent/setup.sh` and reused across every workflow that targets the repo.
- The orchestrator-side change is small, since branch creation is unconditional at clone-time using static template substitution.
- Adding new orchestrator actions later, such as attaching review comments or posting issue updates, means picking a fixed lifecycle pin and a templated source, with no new mechanism required.
- Future demand for "step X gates the run if its output is bad" would be a deliberate departure from this ADR and should be recorded as a successor.
