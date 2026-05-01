# Step outputs are data; orchestrator owns lifecycle at fixed timings; branch is a first-class field

The orchestrator runs lifecycle actions (branch creation, push, change-request open, tracker transition) at fixed pins. Step outputs are pure typed data: they flow into later step prompts and into `change_request` templates, but never reorder when the orchestrator does anything. Because `branch:` is the only field whose action timing is structurally constrained (it has to exist before any step that writes commits), it is lifted out of the step-output mechanism entirely and becomes a first-class workflow field that can be either a static template or a dedicated branch-naming agent — both forms run at clone-time.

Repo-specific bootstrap (`pnpm install`, codegen warm, etc.) is owned by the target repo, not the workflow. The orchestrator runs `.agent/setup.sh` from the cloned repo if present. This keeps workflow files repo-agnostic so the same workflow drives runs across many repos.

## Considered alternatives

- **Inferred timing from output references** (orchestrator schedules each action right after the step that produces its referenced field). Rejected: the only field where action timing is structurally constrained is `branch:`. Building a generic dependency-graph scheduler to handle one structural case is complexity for a single use case.
- **Explicit lifecycle pins in YAML** (workflow author interleaves `lifecycle: create_branch` lines between steps). Rejected: that is a small DSL with rules ("create_branch must precede any step that writes files") and adds YAML surface for no UX gain over the first-class `branch:` field.
- **End-of-run-only branching** (clone, run all steps on `base_branch`, branch + commit + push at the end). Rejected: steps would run with `git status` showing them on `main`, surprising mid-run, and incompatible with workflows that want intermediate commits to be visible on the agent's branch.
- **Sandcastle-style "agent owns git and gh"** (orchestrator is glue; LLM runs `git checkout`, `git push`, `gh pr create`). Rejected: incompatible with the platform-abstraction goal (`TrackerAdapter`/`CodeHostAdapter` for GitHub/GitLab/Jira), gives up validation and audit, and removes the retry/rollback hooks the orchestrator needs.
- **Workflow-level `setup:` block** (bootstrap script lives in `workflow.yaml`). Rejected: the same workflow is meant to run across many repos with different package managers and bootstrap requirements. Putting setup in the workflow either forces one workflow per repo or pushes a brittle "if pnpm-lock else if yarn.lock" ladder into the config. Cursor (`.cursor/environment.json`), GitHub Copilot coding agent (`copilot-setup-steps.yml`), and OpenHands (`AGENTS.md`) all put bootstrap in the target repo for the same reason.

## Consequences

- The workflow file's surface stays small: `branch`, `change_request.{title,body,labels,draft}`, `steps[]`. Three user-facing concepts.
- Repo-specific bootstrap is the repo author's job, defined once in `.agent/setup.sh` and reused across every workflow that targets the repo.
- The orchestrator-side change is small: branch creation is unconditional at clone-time using static template substitution.
- Adding new orchestrator actions later (e.g. attaching review comments, posting issue updates) means picking a fixed lifecycle pin and a templated source — no new mechanism needed.
- Future demand for "step X gates the run if its output is bad" would be a deliberate departure from this ADR and should be recorded as a successor.
