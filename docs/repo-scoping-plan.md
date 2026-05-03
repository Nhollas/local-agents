# Living Implementation Plan: Repo Scoping

This is the execution plan for replacing the per-repo configuration model with a scope-based model that lets a Jira project span many repos and lets GitHub/GitLab configurations express group-level scopes. Each slice is one conceptual change, cuts across whichever modules it needs to, and lands as its own reviewable PR.

Keep this document current as implementation proceeds. Update a slice before changing code if scope shifts. Record verification commands when a slice completes.

## Background

Today the orchestrator assumes one tracker = N pre-configured repos enumerated explicitly in `code_host.repos[]`. Jira is further constrained: `config.ts`'s `superRefine` enforces exactly one repo per Jira project, and `jiraTrackerAdapter` takes that repo as a fixed option, hardcoding it into every parsed issue. This makes it impossible for a single Jira project to drive work across multiple repos, which is the dominant case in any org with more than a handful of services.

A second asymmetry sits alongside the first. The GitHub tracker hardcodes its eligibility label as `agent` (with state suffixes `agent:running`, `agent:awaiting-review`) in `trackers/github.ts`, and the `agent` label does double duty as both the eligibility marker *and* the pending-state marker — it is removed when an issue transitions to running. The Jira tracker accepts an optional `labels: string[]` array of *required* labels and otherwise has no eligibility convention; its lifecycle state lives correctly in Jira's workflow status, separate from any label. GitHub also filters by `creator: username` against the authenticated user; Jira does not filter by reporter at all, so anyone in the project who applies the right labels can drag the factory into work.

The target model:

- **Config** carries `code_host.scopes[]`. Each entry is either a specific repo path or a group/namespace prefix that admits any descendant.
- **Config** carries `tracker.trigger_label`, a single string that must be present on an issue for it to be eligible. Both trackers honour it. The orchestrator never mutates the trigger label — it is owned by humans, who apply it to start a run and remove it to take an issue out of scope. Lifecycle state lives in a separate mechanism per tracker (state labels on GitHub, status transitions on Jira).
- **Jira issues** identify their target repo via a `repo:<full-path>` label.
- **The orchestrator** resolves the labelled path against the configured scopes; matches dispatch as runs, non-matches are silently ignored.
- **Both trackers** filter by the authenticated user — GitHub by `creator`, Jira by JQL `reporter = currentUser()` — so only issues created by the bot account run through the factory.
- **GitHub/GitLab** can keep using specific-repo scopes today; group-prefix support follows when those trackers move to org/group-level issue scanning.

## Status Key

| Status | Meaning |
|---|---|
| Not started | No implementation work has begun. |
| In progress | Code is being changed for this slice. |
| Blocked | Work cannot continue without a decision or prerequisite. |
| Ready for review | Code and tests are complete; final checks passed. |
| Done | Reviewed and merged. |

## Global Quality Gates

Every slice must:

- Read existing code in the area before editing.
- Preserve test coverage at its current level.
- Add or update focused tests in the same layer as the behaviour being changed.
- Pass `pnpm lint`, `pnpm typecheck`, and `pnpm test` before being marked ready for review.
- Avoid backwards-compatibility shims. The project is pre-launch; rename, drop, and reshape freely.
- Avoid introducing concepts the orchestrator does not need yet (e.g. fuzzy matching, short-name resolution). The contract is "full path or nothing".

## Sequencing

Slices 1 → 3 are sequential. Each unblocks the next:

- Slice 1 introduces the resolver primitive that slice 3 uses.
- Slice 2 reshapes the `TrackerAdapter` contract and `Issue` data so slice 3 has somewhere to write the resolved repo.
- Slice 3 introduces scope-based config and Jira label-driven repo identification — the user-visible feature.

Slices 4 → 5 are also sequential. Slice 4's new pending filter (`trigger_label` present, state labels absent) requires the negation operator `-label:foo`, which only the GitHub search API supports — so slice 4 introduces a `searchIssues` method on `server/github-client.ts` and uses it tactically. Slice 5 then generalises that same method to do scope-wide org-level scanning across all configured scopes. Slice 5 is required only when group-prefix scopes are wanted for GitHub.

## Slice 1 — Scope Resolver Primitive

**Status:** Not started

**Purpose:** Add the pure resolution primitive the rest of the migration depends on. No call sites updated; no existing behaviour changed.

**Scope:**

- Add `server/scope-resolver.ts` exporting `resolveRepo(path: string, scopes: readonly string[]): RepoSlug | null`.
- Resolution is exact match or path-segment-prefix descendant match. `acme/widgets` matches `acme/widgets/playground/foo` but not `acme/widgets-other`.
- The function returns the *full input path* on match (callers store the actual repo, not the matched scope).
- Empty scopes list returns `null` for any input.
- Overlapping scopes resolve **first-match in iteration order**, not most-specific-match. Documented explicitly: when both `org` and `org/repo` appear in the scope list, the resolver returns whichever appears first.
- The resolver does not verify the repo exists. A typo like `repo:org/typo-here` that descends from a configured `org` scope resolves cleanly; the failure surfaces at clone time in the code host. This is intentional — verifying existence per-resolution would add an API call to every issue scan.
- Unit tests cover: exact match, descendant match, sibling rejection (`widgets` does not match `widgets-other`), no match, empty scopes, and overlapping scopes (first-match semantics).

**Naming convention for examples:** Tests, sample configs, and plan docs use generic placeholders (`acme`, `widgets`, `services`, `other-org`). Do not use real organisation names, customer names, or trademarked identifiers as example values.

**Natural code areas:**

- `server/scope-resolver.ts` (new)
- `server/__tests__/scope-resolver.test.ts` (new)

**Quality gates:**

- No existing call sites updated in this slice.
- 100% coverage of the new module.
- Resolver is a pure function with no I/O, no logging, no DB access.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## Slice 2 — `Issue.repo` and `TrackerAdapter` Shape

**Status:** Ready for review

**Verification:** `pnpm lint`, `pnpm typecheck`, `pnpm test` (319 tests).

**Purpose:** Lift the assumption that the orchestrator knows the repo before asking the tracker. Make `Issue` carry its resolved repo, and let adapters return all eligible issues in a single call rather than being asked per repo. This is a pure structural refactor — no user-visible behaviour change.

**Scope:**

- Add `repo: RepoSlug` to `Issue` in `server/trackers/types.ts`.
- Add `repo: text("repo").notNull().$type<RepoSlug>()` column to the `runs` table in `server/db/schema.ts`. The repo is recorded on dispatch and read by reconciliation/retry, replacing the role `parseIssueKey` plays today for Jira. Pre-launch project — no migration shim, drop and recreate the dev DB.
- Update `RunningRun` / `CompletedRun` / `FailedRun` variants in `server/run-repository.ts` to carry `repo: RepoSlug`. `rowToRun` reads the new column; `seedRun` test helper requires it (or defaults to a sensible test value).
- Change `TrackerAdapter.fetchActiveIssues` from `(repo, state)` to `(state)`. The adapter is responsible for finding all in-scope issues across whatever surface it scans.
- Update `TrackerAdapter.parseIssueKey` for Jira: drop the `repo` field from the `Ok` shape (it is no longer derivable from the key alone). GitHub `parseIssueKey` is unchanged because `org/repo#123` still encodes both.
  - Update `reconcileStaleRuns` ([orchestrator.ts:141-171](server/orchestrator/orchestrator.ts:141)) and `retryRun` ([orchestrator.ts:239-241](server/orchestrator/orchestrator.ts:239)) to read `repo` from the run record instead of from `parseIssueKey`.
- GitHub tracker: keep the existing per-repo iteration internally; loop over the configured repo list and merge results. Stamp `repo` onto each `Issue` as it maps. No external API change.
- Jira tracker: still tied to a single configured repo at this slice (the schema constraint is not yet relaxed). Stamp the configured repo onto every issue. Slice 3 replaces this stamping with label-driven resolution; slice 2 keeps it constant so behaviour is unchanged.
- Orchestrator: call `tracker.fetchActiveIssues(state)` once per state instead of once per repo. Remove the per-repo concurrent fan-out for issue fetching. The `stillRunning: Map<RepoSlug, Set<IssueKey>>` reconciliation map is still constructible from the flat issue list because each `Issue` now carries its repo; rebuild it client-side from the merged result.
- Run-recording sites in `server/run-repository.ts` and `run-lifecycle.ts` accept `repo: RepoSlug` and persist it on `INSERT`.

**Natural code areas:**

- `server/trackers/types.ts`
- `server/trackers/github.ts`, `server/trackers/jira.ts`
- `server/trackers/__tests__/*`
- `server/db/schema.ts`, `server/run-repository.ts`
- `server/__tests__/run-repository.test.ts` (new `repo` round-trip)
- `server/orchestrator/orchestrator.ts`
- `server/orchestrator/run-lifecycle.ts` (anywhere that consumes `parseIssueKey` or persists runs)
- `server/test-helpers/*` (`seedRun`)

**Quality gates:**

- `Issue` type carries `repo: RepoSlug`; no consumer reads repo from anywhere else.
- `runs.repo` is non-null on every persisted run; `rowToRun` projects it on every variant.
- `TrackerAdapter.fetchActiveIssues` takes only `state`. No remaining call site passes a `repo` argument.
- Orchestrator no longer iterates `code_host.repos` to fetch issues. `reconcileStaleRuns` and `retryRun` no longer call `parseIssueKey` to derive repo.
- Behaviour observed by the dashboard is unchanged: same issues, same dispatch order, same retries.
- Tracker tests assert the resulting `Issue` records carry the expected `repo`.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## Slice 3 — Scope-Based Config and Jira Label Resolution

**Status:** Not started

**Purpose:** Make the user-visible feature land. Replace `code_host.repos[]` with `code_host.scopes[]`, drop the 1-repo-per-Jira-project constraint, and have the Jira tracker resolve each issue's target repo from a `repo:<path>` label. Out-of-scope labels are silently ignored.

**Scope:**

- Rename `code_host.repos` → `code_host.scopes` in `server/config.ts`. Each entry is a path string. Type stays `RepoSlug` (the brand carries the path semantics; group prefixes pass the same validation).
- Delete the `superRefine` block in `server/config.ts` that enforces `code_host.repos.length === 1` for Jira.
- Replace `createWorkflowMap` in `server/workflow/workflow-loader.ts`. Today it eagerly builds a `Map<RepoSlug, RepoWorkflow>` from the configured repos ([server.ts:82](server/server.ts:82), consumed at [orchestrator.ts:242](server/orchestrator/orchestrator.ts:242)). With group-prefix scopes, the keys are not knowable in advance. The today-true invariant is that every repo uses the same `workflow.yaml`, so collapse to a single global workflow: drop the map, pass `workflow: RepoWorkflow` directly into the orchestrator, replace `workflows.get(repo)` with a direct workflow reference. If per-repo workflows ever land, this becomes a `resolveWorkflow(repo)` function — but do not pre-build for that future.
- Fix `Issue.labels` semantics on the Jira side. Today `mapJiraIssue` ([trackers/jira.ts:66](server/trackers/jira.ts:66)) sets `labels: [issue.fields.status.name]` — the status name, not real labels. Map from `issue.fields.labels` instead. Audit consumers of `Issue.labels` for any reliance on the status-name behaviour; fix or remove. If `status` is needed elsewhere, expose it as a separate field.
- Update the `JiraIssue` Zod schema in `server/jira-client.ts` to include `fields.labels: string[]` so both the search and get-issue paths surface the real label list.
- Jira tracker:
  - Replace `repo: RepoSlug` in `JiraTrackerOptions` with `scopes: readonly RepoSlug[]`.
  - For each fetched issue: read the now-correct `labels`, find any prefixed `repo:`, run `resolveRepo(value, scopes)` (slice 1). On `null`, drop. On match, attach the resolved repo to the `Issue`.
  - Issues with zero or multiple `repo:` labels are dropped. Multiple-label drops are not an error condition — the operator misconfigured Jira and the orchestrator declines to guess.
  - Drops are logged at info level via `canonicalLog` with `{ event: "issue_dropped", reason, issueKey }` so operators can diagnose missing runs without dashboard support. The three reasons are `no_repo_label`, `multiple_repo_labels`, `unresolved_repo_label`.
- GitHub code-host wiring still treats each scope as a specific repo at this slice (group-prefix support for GitHub is slice 5).
- Update sample `config.yaml` to demonstrate the new shape.

**Natural code areas:**

- `server/config.ts`
- `server/trackers/jira.ts`
- `server/jira-client.ts` (`JiraIssue` schema)
- `server/trackers/__tests__/jira.test.ts`
- `server/workflow/workflow-loader.ts` and `server/workflow/__tests__/workflow-loader.test.ts`
- `server/orchestrator/orchestrator.ts` (workflow lookup at line 242)
- `server/server.ts` (wiring)
- `config.yaml` (sample)

**Quality gates:**

- `Config` type exposes `code_host.scopes: RepoSlug[]`; no surviving reference to `code_host.repos`.
- Jira `superRefine` constraint is removed; a Jira config with multiple scopes parses cleanly.
- `createWorkflowMap` is gone (or has been replaced by a runtime resolver, per design choice in scope above). `workflows.get(repo)` no longer appears in the orchestrator.
- `mapJiraIssue` reads `Issue.labels` from `fields.labels`, not `fields.status.name`. Asserted by a unit test that mocks both fields and verifies the mapped output.
- Jira adapter tests cover: single matching `repo:` label dispatched, no `repo:` label dropped (logged with reason `no_repo_label`), unresolved `repo:` label dropped (`unresolved_repo_label`), multiple `repo:` labels dropped (`multiple_repo_labels`), label that matches a group-prefix scope dispatches to the full path.
- A Jira config with zero `repo:` labels on every issue produces zero runs and zero errors.
- GitHub behaviour is unchanged: scopes are interpreted as specific repos exactly as `repos` was.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## Slice 4 — Trigger Label, Lifecycle Separation, and Reporter Parity

**Status:** Not started

**Purpose:** Establish a clean, symmetric model for issue eligibility and lifecycle state across both trackers. The trigger label is a pure marker that humans apply and remove; the orchestrator never mutates it. Lifecycle state lives in a separate mechanism per tracker (state labels on GitHub, status transitions on Jira). Bring Jira to parity with GitHub on creator/reporter filtering.

After this slice, an issue is eligible only when (a) it carries the configured trigger label and (b) it was created by the authenticated tracker account — consistently across both trackers. The trigger label remains on the issue throughout its entire lifecycle, so a human filter on the trigger label always shows every factory-scoped issue regardless of state.

**Scope:**

- Add `tracker.trigger_label: string` (required) to both the `kind: github` and `kind: jira` config variants in `server/config.ts`.
- Remove the existing `tracker.labels` array on the Jira variant. The pre-launch project takes the breaking rename without a shim.
- Add a `searchIssues(query: string)` method to `server/github-client.ts` wrapping `GET /search/issues`. Slice 5 generalises the call site; this slice introduces the method because the new pending filter requires the negation operator only the search API supports.
- GitHub tracker (`server/trackers/github.ts`):
  - Replace the module-level `LABELS` constant with two values derived per-instance from the configured trigger label: `running = ${trigger_label}:running`, `awaiting_review = ${trigger_label}:awaiting-review`. There is no `pending` state label — pending is signalled by the *absence* of any state label, mirroring how Jira signals pending via the `To Do` status.
  - `fetchActiveIssues` filtering becomes:
    - Pending: `trigger_label` present, `:running` and `:awaiting-review` both absent. Use the search API (`-label:foo`) for the negation; the simple list endpoint cannot express it.
    - Running: `trigger_label` AND `:running` (comma-separated AND on the list endpoint).
    - Awaiting review: `trigger_label` AND `:awaiting-review`.
  - `transitionState` swaps state labels only. The trigger label is read but never written. Specifically: `pending → running` adds `:running`; `running → awaiting_review` removes `:running` and adds `:awaiting-review`. No transition involves the trigger label.
  - The existing `creator: username` filter via `getAuthenticatedUser()` stays unchanged; it is already correct.
- Jira tracker (`server/trackers/jira.ts`):
  - Replace the optional `labels: readonly string[]` adapter option with a required `triggerLabel: string`.
  - JQL `labels in (...)` clause becomes `labels = "<trigger_label>"` (single-value equality).
  - Add `reporter = currentUser()` to the JQL clause set in `fetchActiveIssues`. `currentUser()` resolves server-side, so no Jira client method is needed.
  - `transitionState` already moves the issue between statuses without touching labels — that is correct and unchanged. Add a unit test that asserts the trigger label is still present on the issue after a transition (regression guard).
- Update sample `config.yaml` with `trigger_label: local-agents` (or similar) on the tracker block.
- The reporter/creator filter is always-on; there is no opt-out and no config knob.

**Natural code areas:**

- `server/config.ts`
- `server/trackers/github.ts`, `server/trackers/jira.ts`
- `server/github-client.ts` (search API method, if not already exposed)
- `server/trackers/__tests__/*`
- `server/server.ts` (wiring)
- `config.yaml` (sample)

**Quality gates:**

- `tracker.trigger_label` is required in config for both tracker kinds; missing config fails Zod parsing.
- No surviving hardcoded `"agent"` literal in `server/trackers/github.ts`. Verified by `rg -n '"agent' server/trackers/github.ts` returning no hits.
- Jira adapter no longer accepts a `labels` array; the option is `triggerLabel: string`.
- The GitHub `transitionState` implementation never calls `removeIssueLabel` or `addIssueLabels` with the trigger label value. Verified by a unit test that captures every label-mutation call across all three transitions.
- The Jira `transitionState` implementation never invokes any label-mutation client method. Verified by a unit test asserting only `transitionIssue` is called.
- GitHub tracker tests assert that an issue still carrying only the trigger label is treated as pending (no state label required to be picked up).
- Jira tracker tests assert the JQL contains `reporter = currentUser()` and a single-label equality clause built from the configured value.
- Issues lacking the trigger label produce no runs on either tracker.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## Slice 5 — GitHub Tracker: Org-Level Issue Scanning

**Status:** Not started

**Purpose:** Make group-prefix scopes meaningful for the GitHub tracker. Today the GitHub adapter calls `listIssues` once per configured repo; this is incompatible with a scope like `acme` that should match any repo in the org. Switch to an org-level or search-based fetch that works across the full scope.

**Scope:**

- Generalise the `client.searchIssues(query)` method introduced in slice 4 so the GitHub adapter can issue scope-wide queries. One call per distinct org appearing in `scopes`, with a query shape like `org:foo label:<trigger_label> author:bot is:open` plus the per-state label filter (or negation, for pending).
- Replace per-repo `client.listIssues(repo, …)` iteration in `server/trackers/github.ts` entirely. Pending, running, and awaiting-review queries all flow through `searchIssues` so a single fetch covers every scope.
- Filter results client-side using `resolveRepo` against the configured scopes; drop issues whose repo does not resolve. Specific-repo scopes still work — they just become trivial single-result resolutions.
- For each surviving issue, derive `RepoSlug` from the issue's `repository_url` and stamp it onto the `Issue`.
- Rate-limit posture: the GitHub Search API has a 30 req/min authenticated limit (separate from the 5000/hr core bucket) and caps results at 1000 per query. At a 30 s tick interval one call per org per state is comfortable; document the ceiling in the GitHub client and surface a clear error if the result-count cap is hit, rather than silently truncating.
- Tests: scope = whole org admits any repo in that org; scope = specific repo admits only that repo; mixed scope list (org-prefix + specific repos in another org) works; the search-result-count cap surfaces as an explicit error.

**Natural code areas:**

- `server/github-client.ts`
- `server/trackers/github.ts`
- `server/trackers/__tests__/github.test.ts`

**Quality gates:**

- Number of GitHub API calls per orchestrator tick is `O(distinct orgs in scopes)`, not `O(repos)`.
- Group-prefix scopes (`org` or `org/team-prefix` if GitHub later adds nested groups) admit descendant repos correctly.
- No regression in single-repo behaviour: a config with one specific-repo scope produces the same runs as before.
- GitLab code-host wiring is untouched (the GitLab *tracker* does not exist yet; this slice is GitHub only).
- `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## Out of Scope

- A GitLab tracker adapter. The scope model is designed to fit one cleanly when added (label-driven, group-prefix-aware), but adding it is its own slice.
- Service-catalog integration (e.g. a Backstage-style `service: foo` label that resolves to a repo via an external lookup). This is org-specific glue best layered as automation that *writes* the `repo:` label before the factory sees the issue.
- Short-name or fuzzy repo resolution. The contract is full-path-or-nothing.
- Dashboard surfacing of dropped/unresolved issues. Add only if real users ask.

## Release-Level Acceptance

The migration is complete when:

- A single Jira project drives runs across many repos via per-issue `repo:` labels.
- `code_host.scopes[]` accepts both specific repos and group prefixes; both are honoured by every tracker that knows about scopes.
- `tracker.trigger_label` is the single source of truth for issue eligibility on both trackers; no hardcoded `agent` literal survives.
- The trigger label is never mutated by the orchestrator on either tracker. A human filter on the trigger label shows every factory-scoped issue in any lifecycle state.
- Both trackers filter by the authenticated user (GitHub `creator`, Jira `reporter = currentUser()`); issues created by anyone else are silently excluded.
- An issue whose `repo:` label does not resolve against any scope produces no run, no error, and no dashboard noise.
- Tracker call counts per orchestrator tick scale with `O(orgs/projects)`, not `O(repos)`.
- Test coverage is at or above the level recorded at the start of slice 1.
