# Living Implementation Plan: Shell Expansion, Multi-Phase Workflows, GitLab & Jira

This is the execution plan for [design-shell-expansion-and-integrations.md](./design-shell-expansion-and-integrations.md). The design doc describes what to build; this plan tracks how to slice and verify the work.

Keep this document current as implementation proceeds. When a slice starts, update its status. When scope changes, update the slice before changing code. When a slice completes, record the verification commands that passed and any deferred follow-up.

## Status Key

| Status | Meaning |
|---|---|
| Not started | No implementation work has begun. |
| In progress | Code is being changed for this slice. |
| Blocked | Work cannot continue without a decision or prerequisite. |
| Ready for review | Code and tests are complete; final checks passed. |
| Done | Reviewed and merged. |

## Global Quality Gates

Every implementation slice must preserve the existing repo standards:

- Read the code and tests in the area before editing. Existing test helpers are the conventions.
- Keep the slice small enough to review independently.
- Update docs in the same slice when behavior or config changes.
- Add or update focused tests in the same layer as the behavior being changed.
- Keep GitHub-only behavior working unless the slice explicitly changes it.
- Do not leave compatibility gaps between config, server startup, orchestrator behavior, dashboard assumptions, and docs.
- Run `pnpm lint`, `pnpm typecheck`, and `pnpm test` before marking a slice ready for review.
- Run `pnpm test:coverage` before the first slice starts and after feature slices that add behavior. Coverage should stay level or improve.
- Run narrower tests while iterating, but do not use narrow tests as the final gate.

Recommended final verification block for every slice:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Coverage checkpoint:

```bash
pnpm test:coverage
```

## Operating Model

This work should not be implemented as one long-running agent session. Use the plan as a sequence of independently reviewable slices.

Recommended workflow:

1. Create one branch per slice.
2. Start one Codex thread per slice, or continue in the current thread only while the context is still fresh.
3. Keep only one implementation slice in progress on a branch at a time.
4. Commit each slice when its quality gates pass.
5. Update this plan before and after implementation work in the same branch.
6. Open or review each slice independently before starting dependent slices.

Branch naming convention:

```text
plan/slice-01-code-host-repos
plan/slice-02-global-workflow
plan/slice-03-tracker-state
plan/slice-04-shell-expansion
plan/slice-05-multi-phase
plan/slice-06-gitlab
plan/slice-07-jira
plan/slice-08-docs-refresh
```

Commit strategy:

- Commit at the end of each slice after `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass.
- Prefer one clean commit per slice unless the slice is large enough to justify multiple reviewable commits.
- Do not commit half-passing work unless intentionally creating a checkpoint branch for handoff.
- If a context window is getting tight, stop at a clean boundary: update the slice progress notes, record failing/passing commands, and commit only if the work is coherent.

Parallelism:

- Slices 1, 2, and 3 should be done sequentially because they reshape shared config, workflow loading, and tracker contracts.
- Slice 4 depends on the config/workflow foundations being stable enough to integrate prompt expansion.
- Slice 5 depends on Slice 4.
- Slice 6 can be implemented after Slice 1 and can run in parallel with Slice 4 if it stays inside GitLab code-host files and config wiring.
- Slice 7 depends on Slice 3 and should not run in parallel with tracker contract changes.
- Slice 8 should be last, after behavior has landed.

Multiple Codex instances are useful when each instance owns a disjoint slice on its own branch. Avoid two instances editing the same branch unless one is only reviewing.

## Progress Discipline

Every implementation thread should update this document. Treat it as the project ledger, not just a plan.

When starting a slice:

- Change `Status` from `Not started` to `In progress`.
- Add an `Owner / thread` line if helpful.
- Add a short `Started` note with date and branch.

When pausing a slice:

- Leave the status as `In progress` or `Blocked`.
- Add a `Progress notes` subsection with what changed, what remains, and exact verification status.
- Record any failing command output in summary form, not as a large pasted log.

When completing a slice:

- Change `Status` to `Ready for review`.
- Add a `Completed changes` subsection.
- Add a `Verification` subsection listing the exact commands that passed.
- After merge, change `Status` to `Done`.

Use this handoff template when a slice is interrupted:

```markdown
**Progress notes:**

- Branch:
- Files changed:
- Completed:
- Remaining:
- Verification:
- Known risks:
```

## Slice 0 — Baseline And Planning Hygiene

**Status:** Ready for review

**Started:** 2026-04-30 on branch `plan/slice-00-baseline-planning`.

**Completed changes:**

- Confirmed `design-shell-expansion-and-integrations.md` is the implementation spec and points to this living plan as the execution ledger.
- Kept `design-shell-expansion-and-integrations-decisions.md` as the rationale trail and corrected the rejected per-repo workflow path to `.agents/workflow.yaml`.
- Aligned the design doc implementation-order section with this plan's slice sequence.
- Recorded the baseline coverage checkpoint: 100% statements, 100% branches, 100% functions, 100% lines.

**Verification:**

- `pnpm install`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:coverage`

**Purpose:** Establish the baseline before code changes and make sure docs do not contradict the settled design.

**Scope:**

- Confirm [design-shell-expansion-and-integrations.md](./design-shell-expansion-and-integrations.md) is the implementation spec.
- Keep [design-shell-expansion-and-integrations-decisions.md](./design-shell-expansion-and-integrations-decisions.md) as the rationale trail.
- Record baseline coverage before implementation begins.

**Quality gates:**

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:coverage`
- No stale references in implementation docs to rejected design choices such as `completion_signal`, `max_iterations`, `PROJ#42`, top-level `repos`, or per-target-repo workflow loading.

## Slice 1 — Move Repos Under `code_host`

**Status:** Ready for review

**Started:** 2026-04-30 on branch `plan/slice-01-code-host-repos`.

**Completed changes:**

- Moved repository configuration from top-level `repos` to `code_host.repos`.
- Updated `Config` types, Zod parsing, server startup wiring, and test config helpers to use `code_host.repos`.
- Chose no compatibility window for top-level `repos`; the parser rejects old top-level repo config.
- Updated README and architecture config examples to show only the new nested shape.
- Added focused config parser tests for accepted nested repos, missing `code_host.repos`, and rejected top-level `repos`.

**Verification:**

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

**Purpose:** Make the config shape match the settled model before adding more provider options.

**Scope:**

- Move config from top-level `repos` to `code_host.repos`.
- Keep the config key singular: `code_host`.
- Update `Config` types, Zod schema, config loading, test config helpers, server bootstrap, and docs.
- Decide whether to support a short deprecation window for top-level `repos`; if supported, warn loudly and normalize internally.

**Natural code areas:**

- `server/config.ts`
- `server/server.ts`
- `server/testing/support/test-config.ts`
- `README.md`
- `docs/architecture.md`

**Tests:**

- Config parser accepts `code_host.repos`.
- Config parser rejects missing `code_host.repos`.
- If no compatibility window is chosen, parser rejects top-level `repos`.
- Server startup and test helpers pass repos through from `code_host.repos`.

**Quality gates:**

- Existing GitHub-only orchestration tests still pass.
- Public docs show only the new config shape.
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

## Slice 2 — Global Local `workflow.yaml`

**Status:** Ready for review

**Started:** 2026-04-30 on branch `plan/slice-02-global-workflow`.

**Completed changes:**

- Replaced per-target-repo workflow fetching and refresh behavior with a one-shot local `workflow.yaml` loader.
- Added a workflow map helper so the same loaded workflow applies to every configured repo.
- Updated server startup and shutdown wiring to stop using workflow refresh timers or `codeHost.fetchFile()` for workflow loading.
- Replaced workflow cache integration tests with local loader tests for successful load, missing file, invalid YAML, and shared workflow fan-out across repos.
- Updated README and architecture docs to describe global workflow loading from the local-agents working directory.

**Verification:**

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

**Purpose:** Replace per-target-repo workflow fetching with one workflow file owned by local-agents.

**Scope:**

- Replace workflow cache behavior with a one-shot local file loader.
- Load `./workflow.yaml` relative to the orchestrator working directory.
- Remove polling refresh and last-known-good workflow cache behavior.
- Stop using `codeHost.fetchFile()` for workflow loading.
- Update startup wiring and tests.

**Natural code areas:**

- `server/workflow/workflow-loader.ts`
- `server/workflow/workflow.ts`
- `server/server.ts`
- `server/orchestrator/orchestrator.ts`
- `server/workflow/__tests__/workflow-loader.test.ts`
- Orchestrator test helpers that currently pass workflow maps.

**Tests:**

- Loads a local workflow successfully.
- Fails startup or loader call clearly when `workflow.yaml` is missing.
- Fails clearly when local workflow YAML is invalid.
- Dispatch uses the same loaded workflow for every configured repo.
- Existing hook behavior is unchanged for single-prompt workflows.

**Quality gates:**

- No remaining production dependency on target repo `.agents/workflow.yaml`.
- `docs/architecture.md` no longer describes per-repo workflow caching as current behavior.
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

## Slice 3 — Tracker State Refactor

**Status:** Ready for review

**Started:** 2026-04-30 on branch `plan/slice-03-tracker-state`.

**Completed changes:**

- Introduced `TrackerState = "pending" | "running" | "awaiting_review"`.
- Renamed `TrackerAdapter.swapLabel` to `transitionState` and updated orchestrator/decorator usage.
- Moved GitHub label mapping into `server/trackers/github.ts`.
- Replaced orchestrator-owned issue-key parsing with `tracker.parseIssueKey`.
- Added GitHub tracker tests for logical-state label mapping and issue-key parsing.
- Added an orchestrator dispatch test proving logical tracker states are passed to the tracker.

**Verification:**

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

**Purpose:** Make tracker state platform-neutral before adding Jira.

**Scope:**

- Introduce `TrackerState = "pending" | "running" | "awaiting_review"`.
- Rename `TrackerAdapter.swapLabel` to `transitionState`.
- Move GitHub label mapping into `server/trackers/github.ts`.
- Rename the misleading `completed` logical state to `awaiting_review`.
- Add `TrackerAdapter.parseIssueKey`.
- Move GitHub issue key parsing out of the orchestrator and into the GitHub tracker adapter.

**Natural code areas:**

- `server/trackers/types.ts`
- `server/trackers/github.ts`
- `server/trackers/decorator.ts`
- `server/orchestrator/orchestrator.ts`
- `server/orchestrator/__tests__/*`
- `server/trackers/__tests__/*`

**Tests:**

- GitHub adapter maps logical states to existing labels.
- Orchestrator calls `transitionState` with logical states, not label strings.
- `parseIssueKey` parses `owner/repo#42`.
- Existing retry paths use adapter-owned parsing.
- Existing canonical logging still records useful transition information.

**Quality gates:**

- No behavior change for GitHub-only users.
- No orchestrator-owned GitHub label constants remain.
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

## Slice 4 — Shell Expansion

**Status:** Ready for review

**Started:** 2026-04-30 on branch `plan/slice-04-shell-expansion`.

**Completed changes:**

- Added trusted shell block marking and expansion helpers with a hard-coded 30-second timeout.
- Expanded only template-authored marked shell blocks after prompt rendering and before `query()`.
- Executed expansion commands in the workspace directory and in parallel.
- Failed runs on shell non-zero exit, timeout, signal termination, and spawn errors.
- Stripped internal marker characters from rendered variables and final prompts so issue title and description content cannot forge executable shell blocks.
- Added workflow helper and orchestrator integration tests for expansion, workspace cwd, parallel execution, variable substitution, injection prevention, marker stripping, literal unmarked shell text, and strict failure behavior.

**Verification:**

- `pnpm test:coverage`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

**Purpose:** Add trusted pre-prompt shell expansion with strict failure behavior.

**Scope:**

- Add shell block marking and expansion helpers.
- Execute only template-authored marked blocks.
- Run commands in the workspace directory.
- Run commands in parallel with a 30-second timeout.
- Fail the run on non-zero exit, timeout, or spawn error.
- Ensure marker characters cannot be injected through issue content and never reach the agent prompt.
- Integrate expansion after prompt rendering and before `query()`.

**Natural code areas:**

- `server/workflow/prompt-preprocessor.ts`
- `server/workflow/workflow.ts`
- `server/orchestrator/orchestrator.ts`
- `server/workflow/__tests__/*`
- `server/orchestrator/__tests__/*`

**Tests:**

- Expands stdout from marked shell blocks.
- Executes commands from the workspace directory.
- Runs variable substitution before command execution.
- Does not execute `` !`...` `` injected through issue title or description.
- Strips or prevents marker forgery from variable values.
- Fails on non-zero exit.
- Fails on timeout.
- Fails on spawn error.
- Keeps literal unmarked shell-looking text in the final prompt.
- Orchestrator passes expanded prompt to the agent.

**Quality gates:**

- Security tests cover attacker-controlled issue fields.
- Strict failure behavior is asserted in integration tests, not just unit tests.
- `pnpm test:coverage`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

## Slice 5 — Multi-Phase Workflow Schema And Runner

**Status:** Not started

**Purpose:** Add simple staged prompts without completion signals or orchestrator-level iteration loops.

**Scope:**

- Extend workflow schema to support mutually exclusive `prompt` or `phases`.
- Define phase fields: `name`, `prompt`, optional `resume_previous`.
- Add phase sequencing.
- Expand shell blocks per phase.
- Resume the previous phase session when requested.
- Keep hooks bracketing the whole dispatch.
- Add `runs.phaseIndex` with a migration.
- Emit `phase.started`, `phase.completed`, and `phase.failed` canonical log markers.
- Retry from the failed phase using the failed phase session ID where available.

**Natural code areas:**

- `server/workflow/workflow.ts`
- `server/orchestrator/orchestrator.ts`
- `server/orchestrator/phase-runner.ts`
- `server/db/schema.ts`
- Drizzle migration files
- `server/orchestrator/__tests__/*`
- `server/api/__tests__/*` if run serialization changes.

**Tests:**

- Schema accepts single-prompt workflow.
- Schema accepts phased workflow.
- Schema rejects workflows with both `prompt` and `phases`.
- Schema rejects workflows with neither.
- Phases run sequentially.
- Each phase receives a freshly rendered and shell-expanded prompt.
- `resume_previous` passes the previous session ID.
- Hooks run once around the whole dispatch, not per phase.
- `phaseIndex` updates as phases progress.
- Retry skips completed phases and resumes the failed phase.
- Retry starts failed phase fresh when no failed-phase session ID exists.
- Phase log markers are emitted with name, index, and total.

**Quality gates:**

- No `completion_signal` or `max_iterations` fields in schema or tests.
- Existing single-prompt workflows continue to behave as before.
- Migration is generated and covered by DB tests where practical.
- `pnpm test:coverage`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

## Slice 6 — GitLab Code Host Adapter

**Status:** Not started

**Purpose:** Add GitLab as a code host while preserving the `CodeHostAdapter` contract.

**Scope:**

- Add a GitLab API client.
- Add `server/code-hosts/gitlab.ts`.
- Support `code_host.kind: gitlab`.
- Support optional `code_host.base_url`, defaulting to `https://gitlab.com`.
- Validate `GITLAB_TOKEN` at startup when GitLab is configured.
- Use `PRIVATE-TOKEN` auth.
- URL-encode GitLab project paths.
- Make MR creation idempotent by returning an existing MR for the source branch when present.

**Natural code areas:**

- `server/gitlab-client.ts`
- `server/code-hosts/gitlab.ts`
- `server/config.ts`
- `server/env.ts`
- `server/server.ts`
- `server/code-hosts/__tests__/*`
- `server/testing/support/msw.ts`

**Tests:**

- Config accepts GitLab code host.
- Missing `GITLAB_TOKEN` fails startup when GitLab is configured.
- `cloneUrl` uses configured base URL.
- File fetch calls the correct GitLab API path and decodes file content.
- MR creation checks for an existing MR before creating.
- Project paths with slashes are encoded correctly.

**Quality gates:**

- GitHub code host tests remain unchanged or equivalent.
- Adapter behavior is covered with MSW or equivalent HTTP-level tests.
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

## Slice 7 — Jira Tracker Adapter

**Status:** Not started

**Purpose:** Add Jira Cloud as a tracker on top of the platform-neutral tracker state model.

**Scope:**

- Add a Jira API client.
- Add `server/trackers/jira.ts`.
- Support `tracker.kind: jira`.
- Require `tracker.base_url` and `tracker.project`.
- Support optional `tracker.statuses` with defaults.
- Enforce exactly one `code_host.repos` entry when tracker kind is Jira.
- Validate `JIRA_EMAIL` and `JIRA_API_TOKEN` at startup when Jira is configured.
- Use Jira native issue keys, e.g. `PROJ-42`.
- Implement adapter-owned `parseIssueKey`.
- Fetch active issues with JQL by project and mapped status.
- Transition issues by resolving and posting the transition whose target status matches the logical state.

**Natural code areas:**

- `server/jira-client.ts`
- `server/trackers/jira.ts`
- `server/config.ts`
- `server/env.ts`
- `server/server.ts`
- `server/trackers/__tests__/*`
- `server/testing/support/msw.ts`

**Tests:**

- Config accepts Jira tracker with required fields.
- Config applies default Jira statuses.
- Config accepts custom Jira statuses.
- Config rejects Jira with zero or multiple `code_host.repos`.
- Missing Jira env vars fail startup when Jira is configured.
- `parseIssueKey` accepts `PROJ-42` and rejects malformed keys.
- Active issue fetch builds escaped or otherwise safe JQL.
- Transition resolves available Jira transitions and posts the correct one.
- Jira issues map to the single configured code-host repo in orchestrator flow.

**Quality gates:**

- Jira status mapping stays inside the Jira adapter.
- The orchestrator continues to use only `TrackerState`.
- GitHub tracker tests still pass.
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

## Slice 8 — Documentation And Architecture Refresh

**Status:** Not started

**Purpose:** Bring user-facing docs in line with the implemented system.

**Scope:**

- Update `README.md` setup and configuration examples.
- Update `docs/architecture.md` to describe global workflow loading, logical tracker states, and code-host repos.
- Keep the design and decisions docs linked.
- Add migration notes for users moving from top-level `repos` and per-repo `.agents/workflow.yaml`.

**Tests:**

- Documentation examples match the current config schema.
- Commands and file paths in docs are accurate.

**Quality gates:**

- `rg` finds no stale current-state references to per-repo workflow caching, top-level `repos`, `completion_signal`, `max_iterations`, `PROJ#42`, or logical state `completed`.
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

## Release-Level Acceptance

The overall work is complete when:

- GitHub-only behavior still works with the new config shape and global workflow file.
- Shell expansion is implemented with strict failure and injection protection.
- Multi-phase workflows work with retry from failed phase.
- GitLab can clone/fetch/create MRs through `CodeHostAdapter`.
- Jira can poll/transition issues through `TrackerAdapter`.
- Jira configuration enforces one code-host repo.
- Dashboard/API behavior remains coherent for single-prompt and phased runs.
- Docs describe the implemented behavior, not rejected designs.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and final `pnpm test:coverage` pass.

## Deferred Scope

Do not include these in the initial implementation:

- multiple code host providers at once
- multiple tracker providers at once
- multi-repo Jira disambiguation
- per-repo workflow selection
- configurable GitHub label strings
- per-block shell timeout overrides
- workflow file hot reload
