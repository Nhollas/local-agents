# Design Decisions: Shell Expansion, Multi-Phase Workflows, GitLab & Jira

This document captures the Q&A trail and decisions made while reviewing [design-shell-expansion-and-integrations.md](./design-shell-expansion-and-integrations.md). Several aspects of the original proposal materially changed; this is the source of truth for what we're actually building.

---

## Table of decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Shell-block failure | Strict: non-zero exit, timeout, or spawn error all hard-fail the run. Consumer owns command correctness. |
| 2 | Multi-phase model | Simple: phases = staged prompts. Drop `completion_signal` and `max_iterations` from the schema. |
| 3 | Phase retry | Resume the failed phase using its in-flight session ID. Skip already-completed phases. |
| 4 | Hooks vs phases | Hooks bracket the whole dispatch, not each phase. `before_run` once, `after_run` once. |
| 5 | Tracker API rename | Orchestrator speaks logical state names (`pending`, `running`, `awaiting_review`). Adapters own platform mapping. |
| 6 | Issue key format | Native per platform (`owner/repo#42`, `PROJ-42`). `parseIssueKey` moves onto the adapter. |
| 7 | Workflow location | One global `./workflow.yaml` in the local-agents application repo. Not per-target-repo. |
| 8 | Single workflow only | No multi-workflow, no per-repo workflow override. |
| 9 | Repo config shape | Singular `code_host` owns the `repos` list. Plain string list. `tracker.project` is global. For Jira, enforce exactly one repo. |
| 10 | Shell timeout | Hard-coded 30s. No override knob. |
| 11 | Jira status names | Defaults match Jira out-of-the-box (`To Do`/`In Progress`/`In Review`). Optional override. |
| 12 | Authentication | Jira basic auth (`JIRA_EMAIL` + `JIRA_API_TOKEN`). GitLab `PRIVATE-TOKEN` header (`GITLAB_TOKEN`). Startup-time validation. |
| 13 | Phase observability | One run row per dispatch. Add `phaseIndex` column. Canonical-log markers for phase boundaries. |
| 14 | Implementation order | Refactors first (workflow relocation, tracker rename), then features. |

---

## Detailed Q&A

### Q1 — Shell-block failure behaviour

**Question:** What happens when a `` !`shell command` `` block fails (non-zero exit, timeout, spawn error)?

**Options:**
- **A.** Strict — any non-zero exit fails the run.
- **B.** Lenient — capture stdout+stderr, never fail the run.
- **C.** Hybrid — non-zero substitutes captured output; timeout/spawn errors hard-fail.

**Decision:** **A — strict.**

**Rationale:** Shell blocks are consumer-controlled. Consumers own their workflow and must put commands in that work as expected. The system shouldn't carry weight to handle edge cases caused by malformed commands. `Promise.all` (fail-fast) is the right primitive.

**Consequences:**
- The doc's `grep` example needs `|| true` to handle "no matches" exit code 1.
- The doc's `npm test 2>&1 | tail -5` example needs to be dropped or restructured (would exceed the 30s timeout).

---

### Q2 — Multi-phase workflows: how much machinery?

**Question:** Does multi-phase need `completion_signal` and `max_iterations`, or are staged prompts enough?

**Options:**
- **Simple model** — each phase = one prompt → one `query()` call. Agent runs to natural completion. Optional `resume_previous: true` to share session.
- **Complex model (original doc)** — adds `completion_signal` (substring match) and `max_iterations` (re-invoke until signal produced).

**Decision:** **Simple model.**

**Rationale:**
1. The Claude Agent SDK already handles "agent runs until satisfied" via its tool-use loop. An outer retry loop driven by substring-matching agent prose is duct tape on top of native control flow.
2. `completion_signal` is brittle: false positives on quoted text, false negatives on paraphrasing.
3. `max_iterations` re-invokes the agent without meaningful new input.
4. If a phase isn't producing the desired result, the fix is a better prompt — not retrying the same prompt N times.

**Replacement for `completion_signal`:** under strict shell-block mode, a phase's prompt can include a precondition shell block (e.g., `` !`test -f PLAN.md` ``) that hard-fails the run if the prior phase didn't deliver its output.

---

### Q3 — Phase retry semantics

**Question:** When phase 2 of 3 fails, what should `retryRun` do?

**Options:**
- **A.** Restart from phase 1 (redoes work).
- **B.** Restart from the failed phase, fresh session.
- **C.** Restart from the failed phase, resume the in-flight session.

**Decision:** **C.**

**Rationale:**
- Today's single-prompt retry already resumes the failed run's session. Multi-phase is a generalisation: "resume whatever was running when we failed" — for single-prompt that's the only session; for multi-phase that's the failed phase's session.
- Consumer mental model is "retry = continue from where it broke".
- Implementation: persist `phaseIndex` alongside the existing `sessionId` on the run row.

**Edge cases:**
- Phase 2 had `resume_previous: true` and failed before any messages → session ID is still phase 1's. Re-resume that session, run phase 2's prompt against it. Identical to a forward run.
- Phase 2 had no `resume_previous` and failed before any messages → no session for phase 2. Start phase 2 fresh.
- Workspace state (commits, branch) carries through retries (already true today).

---

### Q4 — Hook timing across phases

**Question:** Do `before_run` and `after_run` bracket each phase, or the whole dispatch?

**Decision:** **Bracket the whole dispatch.** `before_run` runs once before phase 1; `after_run` runs once after the final phase succeeds.

**Rationale:** Hooks are workflow concerns, not phase concerns. They handle workspace setup (e.g., `git config user.email`) and run-completion (e.g., `npm run lint:fix`) — naturally once-per-dispatch operations. Per-phase setup, if ever needed, can live as inline shell blocks at the top of a phase's prompt.

---

### Q5 — Tracker API rename: logical states vs platform strings

**Question:** When the orchestrator transitions an issue's state, does it pass logical state names (`pending`, `running`, `awaiting_review`) or platform-specific strings (`agent`, `agent:running`, `agent:awaiting-review`)?

**Decision:** **Logical state names. Adapters own platform mapping.**

**Concrete changes:**
- `TrackerAdapter.swapLabel` → `TrackerAdapter.transitionState`. Signature takes `from: TrackerState` and `to: TrackerState`.
- `type TrackerState = "pending" | "running" | "awaiting_review"`.
- The `LABELS` constant moves from `orchestrator.ts:18-22` into `server/trackers/github.ts`. Stays hardcoded — not configurable for now.
- The Jira adapter holds a `Record<TrackerState, string>` resolved from config at construction time.
- Rename `completed` → `awaiting_review` everywhere. `completed` was misleading: the issue isn't completed, the agent finished and a human still has to review.

**Rationale:** Single Responsibility — the orchestrator's job is "issue is pending → claim it → run agent → mark for review". It shouldn't care what label/status string each platform uses.

---

### Q6 — Issue key format for Jira

**Question:** How do Jira issue keys look in the system — `PROJ#42` (matches existing parser) or `PROJ-42` (Jira-native)?

**Decision:** **Native per platform. `owner/repo#42` for GitHub, `PROJ-42` for Jira.**

**Implementation:** `parseIssueKey(key): { repo, number }` moves onto `TrackerAdapter`. Each adapter knows its own format. Orchestrator's private `parseIssueKey` function (`orchestrator.ts:24-30`) is removed; calls become `tracker.parseIssueKey(...)`.

**Rationale:**
- Dashboard displays match what users see in their tracker UI.
- Log lines / canonical logs become grep-friendly.
- Workspace directory names are clean (`PROJ-42` survives `sanitizeKey` unchanged).
- 6-line parser is trivial to relocate.
- Generalises to future adapters (Linear `ENG-123`, etc.).

---

### Q7 — Workflow file location

**Question:** Where does `workflow.yaml` live?

**Original (doc):** Per-target-repo at `.agents/workflow.yaml`, fetched via `codeHost.fetchFile`.

**Decision:** **One global `workflow.yaml` in the local-agents application repo.**

**Rationale:**
- Per-target-repo workflows assume the operator can commit files into every target repo (might not own them).
- Per-target-repo means clutter and drift across repos.
- The local-agents application should own its own configuration.
- Target repos are *work surfaces*, not config storage.

**Layout:**
```
local-agents/
  config.yaml
  workflow.yaml
```

**Path is hard-coded** at `./workflow.yaml` (relative to the orchestrator's working directory). No config knob.

---

### Q8 — Single workflow only

**Question:** Do we support multiple workflows referenced by name, with per-repo overrides?

**Decision:** **No. One global workflow applies to every repo.**

**Rationale:** Speculative complexity. No consumer has asked for it. When someone hits a real need (e.g., different `branch` patterns per repo), we add per-repo overrides at that point.

**Note:** Multi-phase still works — phases live *inside* the single workflow file. Multi-phase ≠ multi-workflow.

---

### Q9 — Repo configuration shape

**Question:** When tracker and code host use different identifiers (Jira `PROJ` vs GitLab `myorg/project`), how do you express the link in config?

**Initial proposal (rejected):** Per-entry `tracker_project` field on each repo, with a top-level `default_project` fallback.

**Decision:** **Strip the per-entry override entirely. Use singular `code_host.repos` as the code repo allow-list, and a single global `tracker.project` for Jira. For Jira, enforce exactly one repo per orchestrator instance.**

The config key is `code_host`, not `code_hosts`, because only one code host provider is configured at a time. The existing top-level `repos` field moves under `code_host`.

**Final config shape:**

```yaml
# GitHub-only (today's setup, unchanged)
tracker:
  kind: github

code_host:
  kind: github
  repos:
    - nhollas/target-dummy
    - nhollas/another-repo
```

```yaml
# Jira + GitLab
tracker:
  kind: jira
  base_url: https://yourco.atlassian.net
  project: PROJ                       # required, singular, global
  statuses:                            # optional, defaults shown
    pending: "To Do"
    running: "In Progress"
    awaiting_review: "In Review"

code_host:
  kind: gitlab
  base_url: https://gitlab.example.com
  repos:
    - myorg/payments-api               # exactly one entry when tracker.kind=jira
```

**How adapters derive their identifier:**
- **GitHub adapter:** per-repo `tracker_project = repo` (each repo's issues live in itself).
- **Jira adapter:** global `tracker_project = config.tracker.project`.

**Why one repo for Jira:** A Jira issue knows its project (`PROJ`) but not which repo it's about. With multiple repos under one Jira project, the orchestrator can't tell which to clone for any given issue. Restricting to 1:1 sidesteps the ambiguity. When a real consumer needs multi-repo Jira, we revisit with a deliberate disambiguation mechanism.

**Schema validation:** Discriminated union on `tracker.kind`. Missing/extra fields fail at startup with a clear error.

```typescript
const trackerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github") }),
  z.object({
    kind: z.literal("jira"),
    base_url: z.string().url(),
    project: z.string().min(1),
    statuses: z.object({
      pending: z.string().default("To Do"),
      running: z.string().default("In Progress"),
      awaiting_review: z.string().default("In Review"),
    }).default({}),
  }),
]);
```

---

### Q10 — Shell-block timeout

**Question:** What's the timeout, and is it configurable?

**Decision:** **Hard-coded 30 seconds. No override.**

**Rationale:** Matches the strict-mode spirit. Shell blocks are quick context, not heavy work. If a command needs longer, it's the wrong abstraction — restructure (precompute in `before_run`, write to file, then `!`cat result.txt``).

---

### Q11 — Jira status names

**Question:** Defaults for the three logical states, or require explicit configuration?

**Decision:** **Defaults that match Jira's out-of-the-box workflow. Optional override.**

**Defaults:**
- `pending: "To Do"`
- `running: "In Progress"`
- `awaiting_review: "In Review"`

Consumers with custom Jira workflows override via the `statuses` field.

---

### Q12 — Authentication

**Decisions:**

**Jira:** Basic auth using email + API token.
- Env vars: `JIRA_EMAIL`, `JIRA_API_TOKEN`.
- Header sent: `Authorization: Basic <base64(email:token)>`.
- Only auth method Jira Cloud supports for REST API v3.

**GitLab:** `PRIVATE-TOKEN: <token>` header.
- Env var: `GITLAB_TOKEN` (PAT, project token, or group token with `api` scope).
- More universally compatible than `Authorization: Bearer` (works for all token types, both cloud and self-hosted).

**Validation:** Required env vars are validated at startup based on configured adapter `kind`. Missing = startup error. Same pattern as today's `GITHUB_TOKEN` check.

---

### Q13 — Multi-phase observability

**Question:** How are multi-phase runs represented in the database and dashboard?

**Options:**
- **A.** One row per dispatch with a `phaseIndex` column tracking current phase.
- **B.** One row per phase, chained via `parentRunId`.

**Decision:** **A.**

**Rationale:**
- Multi-phase is conceptually one agent claim on one issue. Phases are sub-units.
- Existing concurrency control and label/state ownership are designed around "one issue = one dispatch". Phases-as-rows breaks that.
- Reusing `parentRunId` for phases conflates retries (we tried again) with phases (we did the next sub-step).
- Keeps runs-table volume bounded.

**Schema change:**
```typescript
runs.phaseIndex: integer("phase_index").default(0)  // 0 = single-prompt or first phase
```

**Canonical-log markers** the orchestrator emits per phase:
- `phase.started` with `{ name, index, total }` at phase start
- `phase.completed` with `{ name, index, durationMs }` at phase end
- `phase.failed` with `{ name, index, error }` on error

The dashboard already renders agent messages from the run; phase markers slot in alongside without UI changes.

**Retry chains** still use `parentRunId`. A 3-phase run that failed at phase 2 and was retried produces two rows tagged to the same issue, the second chained as the parent — but each row represents one dispatch attempt, not one phase.

---

### Q14 — Implementation order

**Decision:** Refactors first to unblock features cleanly. Each item is its own PR.

| # | Work | Type | Depends on |
|---|---|---|---|
| 1 | Workflow file relocation | Refactor | — |
| 2 | Tracker state rename | Refactor | — |
| 3 | Shell expansion | Feature | — |
| 4 | Multi-phase workflows | Feature | 3, schema |
| 5 | GitLab adapter | Feature | — |
| 6 | Jira adapter | Feature | 2 |

**Refactor 1 (workflow relocation):**
- `server/workflow/workflow-loader.ts` is a one-shot loader (`loadWorkflow(path): RepoWorkflow`).
- Polling/refresh/last-known-good logic deleted.
- `codeHost` no longer passed to the workflow loader.
- Server bootstrap (`server.ts:35`) shrinks correspondingly.

**Refactor 2 (tracker rename):**
- `TrackerAdapter.swapLabel` → `TrackerAdapter.transitionState`.
- `LABELS` constant moves into `server/trackers/github.ts`.
- Rename `completed` → `awaiting_review` everywhere.
- Add `TrackerAdapter.parseIssueKey`.
- Pure refactor — no behaviour change in single-tracker GitHub setup.

**Items 3, 5, 6 are independent** and could be done in any order or parallelised after the refactors.

**Item 4 depends on item 3** (phase preconditions use shell blocks).

---

## Final consolidated schemas

### `config.yaml`

```yaml
tracker:
  kind: github | jira
  # When kind=jira:
  base_url: https://yourco.atlassian.net    # required
  project: PROJ                              # required, global
  statuses:                                  # optional, defaults shown
    pending: "To Do"
    running: "In Progress"
    awaiting_review: "In Review"

code_host:
  kind: github | gitlab
  # When kind=gitlab:
  base_url: https://gitlab.example.com       # optional, defaults to https://gitlab.com
  repos:
    - owner/repo                              # plain string list
    # For Jira: exactly one entry

defaults:
  polling_interval_ms: 30000
  max_concurrent: 2
  max_retries: 3
  model: claude-sonnet-4-6
  workspace_root: /tmp/local-agent-workspaces
```

### `workflow.yaml`

```yaml
branch: "agent/issue-{{ issue.number }}"
base_branch: main

hooks:
  after_create: "npm install"
  before_run: "git config user.email bot@example.com"
  after_run: "npm run lint:fix"

# Single-prompt:
prompt: |
  Fix issue {{ issue.number }}...
  !`git log --oneline -5`

# OR multi-phase (mutually exclusive with `prompt`):
phases:
  - name: plan
    prompt: |
      Analyse issue {{ issue.number }}, write plan to PLAN.md.
      !`git log --oneline -5`
  - name: implement
    resume_previous: true
    prompt: |
      Read PLAN.md and implement.
      !`test -f PLAN.md`        # precondition; strict-mode hard-fails if missing
  - name: review
    prompt: |
      Review the diff against the plan.
      !`git diff main...HEAD`
```

### Environment variables

| Var | Required when | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | tracker.kind=github OR code_host.kind=github | GitHub PAT |
| `JIRA_EMAIL` | tracker.kind=jira | Atlassian account email |
| `JIRA_API_TOKEN` | tracker.kind=jira | Jira Cloud API token |
| `GITLAB_TOKEN` | code_host.kind=gitlab | GitLab PAT/PrAT/GAT with `api` scope |

---

## Open items

These were discussed but defer until needed:

- **Multi-repo Jira.** Currently 1:1 enforced. Add a deliberate disambiguation mechanism (e.g., per-repo `tracker_project` override, issue title parsing, or custom Jira field) when a real consumer asks.
- **Multi-workflow.** Single global workflow for now. Add per-repo workflow override when a real consumer asks.
- **Per-block shell timeout override.** Hard-coded 30s for now. Add `!{timeout=N}` syntax or global config knob if needed.
- **Configurable GitHub label strings.** `LABELS` stays hardcoded inside the GitHub adapter. Make configurable when asked.
- **Workflow file watch.** One-shot load at startup. Add filesystem watch / SIGHUP reload if developer ergonomics demand it.
