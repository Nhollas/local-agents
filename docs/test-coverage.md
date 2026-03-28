# Test Coverage Tracker

## Prompt for Agents

You are filling test coverage gaps for this project. This document describes the testing boundaries, what's already covered, and what gaps remain — organized into independent workstreams you can pick up.

**Before writing any test:**

1. Read `CLAUDE.md` at the project root for commands and conventions.
2. Read the existing test files for the module you're covering. The test helpers and patterns already in use ARE the conventions — follow them exactly.
3. Read the production code you're testing. Understand the actual behavior before writing assertions.

**Key conventions:**

- **No `vi.mock`**. Tests use real implementations: in-memory SQLite (via `createTestDb()`), MSW for HTTP, and dependency injection where the production code supports it (e.g., `runAgent` on the orchestrator).
- **Assert via DB state and API responses**, not internal calls.
- **Use `runner.queue.waitForIdle()`** to wait for async job completion. Never use `setTimeout` for waiting.
- Integration tests that hit MSW use the shared setup in `tests/setup/integration.ts` (auto-registered for `*.integration.test.ts` files).
- Shared test helpers live in `tests/support/`: `fixtures.ts` (factories, constants, agent stubs), `msw.ts` (MSW server + `githubHandlers`), `test-db.ts`, `test-config.ts`, `test-workspace.ts`.
- Run `pnpm lint`, `pnpm typecheck`, and `pnpm test` when done.

**Implementation hints for tricky gaps:**

- **Workspace creation failure** (orchestrator rollback test): Don't pre-create the workspace with `preCreateWorkspace()`. The orchestrator will call `ensureWorkspace` which tries `git clone` against the fake MSW URL — git clone fails (not a real repo), the catch block triggers, and the label should roll back to pending.
- **Hook execution** (`before_run`/`after_run`): Pass hooks via `createTestWorkflow({ hooks: { before_run: "touch marker" } })`. Verify the side effect (file exists in workspace dir after tick).
- **`onComplete` failure** (orchestrator): Make the MSW PR creation endpoint (`POST /repos/:owner/:repo/pulls`) return HTTP 500. After the agent completes, the `onComplete` callback will throw. Verify the run status in DB is still "completed" but the label is still `agent:running` (never swapped to `agent:awaiting-review`).
- **`Promise.allSettled` resilience**: Configure two repos in the workflows map. Make one repo's issues endpoint return 500. Verify the other repo's issues are still dispatched.

---

## Workstreams

All 6 workstreams touch different files and can be run in parallel with no merge conflicts. The only shared dependency is `tests/support/fixtures.ts` — workstream 6 may add new fixture helpers, but workstreams 1–5 don't modify that file.

### Workstream 1: Unit — Queue `waitForIdle()`

**File:** `core/queue.test.ts` (existing)

Add tests for the `waitForIdle()` method. 3 gaps.

### Workstream 2: Unit — Workflow

**File:** `core/workflow.test.ts` (new)

Test `renderPrompt` and `parseRepoWorkflow` from `core/workflow.ts`. 8 gaps. These are pure functions — pass input, assert output. No test infrastructure needed beyond vitest.

### Workstream 3: Unit — Agent Logging

**File:** `core/agent-logging.test.ts` (new)

Test `shortPath` and `logAgentMessage` from `core/agent-logging.ts`. 6 gaps. Pure functions. For `logAgentMessage`, construct plain message objects matching the shape `{ type: "assistant", message: { content: [...] } }` and assert what gets passed to the `emitToolUse` callback.

### Workstream 4: Integration — Runner error handling

**File:** `core/runner.integration.test.ts` (existing)

Add tests for callback error isolation and kill edge cases. 3 gaps.

### Workstream 5: Integration — API SSE streaming

**File:** `core/api.integration.test.ts` (existing)

Add test for `GET /events` SSE endpoint. 1 gap. Requires starting a stream, emitting a run event via the runner, and asserting the SSE message is received.

### Workstream 6: Integration — Orchestrator + Workflow Cache

**Files:** `core/orchestrator.dispatch.integration.test.ts` (existing), `core/orchestrator.reconcile.integration.test.ts` (existing), `core/workflow-cache.integration.test.ts` (existing), possibly `tests/support/fixtures.ts`

This is the largest workstream — 12 gaps across dispatch, reconcile, and workflow cache. Keep as a single workstream because the tests share infrastructure and some gaps interact (e.g., workspace failure triggers both the rollback logic AND the label swap).

---

## Testing Boundaries

The system has three natural test boundaries:

1. **Unit** — Pure functions with multiple code paths. No I/O, no DB, no network. Test inputs → outputs directly. These are functions where edge cases would be awkward to reach through integration tests because the surrounding setup cost dwarfs what's being verified.

2. **Integration** — Modules that coordinate I/O. Verify via DB state and API/HTTP responses using real in-memory SQLite, Hono test client, and MSW. The orchestrator, runner, API, and workflow-cache all fall here.

3. **Transitive** — Thin adapters and wrappers whose logic is simple enough that they don't warrant standalone tests. Their behavior is verified as a side effect of integration tests exercising the full call path. Modules here must be reviewed: "transitive" coverage can be illusory if integration tests only hit the happy path.

---

## Unit Tests

### Queue (`core/queue.ts`) — `queue.test.ts`

| Behavior | Status |
|---|---|
| Immediate execution under capacity | Covered |
| Queues jobs at max concurrency | Covered |
| Drains pending when slot opens | Covered |
| FIFO ordering | Covered |
| Default max concurrency (5) | Covered |
| Configurable max concurrency | Covered |
| Job failure doesn't block queue | Covered |
| `waitForIdle()` resolves when already idle | Gap — workstream 1 |
| `waitForIdle()` resolves after last job completes | Gap — workstream 1 |
| `waitForIdle()` with multiple waiters | Gap — workstream 1 |

### Workflow (`core/workflow.ts`) — No test file

Pure functions: template interpolation (`renderPrompt`) and YAML validation (`parseRepoWorkflow`). No I/O.

`renderPrompt` is called transitively by orchestrator tests with `"Fix issue {{ issue.number }}: {{ issue.title }}"` and `"agent/issue-{{ issue.number }}"`, but that only exercises basic nested path resolution. The function handles null values, missing variables, arrays, and deeply nested paths — none of these are reached transitively.

`parseRepoWorkflow` is called transitively by the workflow-cache integration test, but only for a fully-specified YAML file. Default values (branch, base_branch) and validation errors (missing `prompt`) are not reached.

| Behavior | Status | Notes |
|---|---|---|
| `renderPrompt` nested path (`issue.number`) | Transitive | via orchestrator dispatch |
| `renderPrompt` missing variable returns empty string | Gap — workstream 2 | |
| `renderPrompt` null in path returns empty string | Gap — workstream 2 | |
| `renderPrompt` array variable joins with comma | Gap — workstream 2 | e.g. `{{ issue.labels }}` |
| `renderPrompt` `attempt` variable | Gap — workstream 2 | |
| `parseRepoWorkflow` valid YAML | Transitive | via workflow-cache integration |
| `parseRepoWorkflow` applies defaults when fields omitted | Gap — workstream 2 | `branch`, `base_branch` |
| `parseRepoWorkflow` rejects missing `prompt` | Gap — workstream 2 | |
| `parseRepoWorkflow` invalid YAML throws | Gap — workstream 2 | |

### Agent Logging (`core/agent-logging.ts`) — No test file

Pure functions: `shortPath` strips workspace prefixes, `logAgentMessage` extracts text and tool use from SDK message objects.

These are NOT exercised transitively. The orchestrator tests inject `noopAgent`/`hangingAgent` which yield no messages, so `logAgentMessage` never executes in any test.

| Behavior | Status |
|---|---|
| `shortPath` strips workdir prefix | Gap — workstream 3 |
| `shortPath` strips `/private` macOS prefix | Gap — workstream 3 |
| `shortPath` returns full path when no prefix matches | Gap — workstream 3 |
| `logAgentMessage` extracts text content and truncates to 200 chars | Gap — workstream 3 |
| `logAgentMessage` extracts tool_use and calls `emitToolUse` | Gap — workstream 3 |
| `logAgentMessage` reads `file_path`, `pattern`, or `command` from tool input | Gap — workstream 3 |

---

## Integration Tests

### Runner (`core/runner.ts`) — `runner.integration.test.ts`

Tests use real in-memory SQLite. Assertions verify DB state. Correct boundary — the runner's job is lifecycle persistence.

| Behavior | Status |
|---|---|
| Records running status on enqueue | Covered |
| Marks completed with duration | Covered |
| Marks failed with error message | Covered |
| Persists lifecycle events (started → completed) | Covered |
| Persists failure events (started → failed) | Covered |
| Records tool_use events via `emitToolUse` | Covered |
| Kill aborts running job | Covered |
| `onComplete` callback fires on success | Covered |
| `onFinally` callback fires on failure | Covered |
| `onComplete` NOT called on failure | Covered |
| `onComplete` failure doesn't corrupt run status | Gap — workstream 4 |
| `onFinally` failure doesn't corrupt run status | Gap — workstream 4 |
| Kill returns false for unknown runId | Gap — workstream 4 |

### API (`core/api.ts`) — `api.integration.test.ts`

Tests use Hono's test client + in-memory SQLite. Correct boundary — verifies HTTP responses against DB state.

| Behavior | Status |
|---|---|
| `GET /health` returns OK | Covered |
| `GET /runs` returns empty when none exist | Covered |
| `GET /runs` orders by startedAt descending | Covered |
| `GET /runs` filters by agent name | Covered |
| `GET /runs` filters by status | Covered |
| `GET /runs` respects limit parameter | Covered |
| `GET /runs/:id` returns run with events ordered by createdAt | Covered |
| `GET /runs/:id` returns 404 for unknown | Covered |
| `POST /runs/:id/kill` kills running job | Covered |
| `POST /runs/:id/kill` returns 404 for unknown | Covered |
| `GET /events` SSE stream delivers run events | Gap — workstream 5 |

### Orchestrator Dispatch (`core/orchestrator.ts`) — `orchestrator.dispatch.integration.test.ts`

Tests use MSW + in-memory SQLite + real runner. Correct boundary.

| Behavior | Status |
|---|---|
| Dispatches agent for pending issue | Covered |
| Swaps label from pending → running during dispatch | Covered |
| Creates DB run record | Covered |
| Creates PR on successful completion (via `onComplete`) | Covered |
| Swaps label to awaiting-review on completion | Covered |
| Respects `max_concurrent` limit | Covered |
| Dispatches oldest issues first | Covered |
| Skips issues that already have a running agent | Gap — workstream 6 |
| Rollback label (running → pending) when workspace creation fails | Gap — workstream 6 |
| `before_run` hook executes before agent starts | Gap — workstream 6 |
| `after_run` hook executes after agent handler completes | Gap — workstream 6 |
| `before_run` failure doesn't prevent dispatch | Gap — workstream 6 |
| `onComplete` failure (PR creation 500) — identifies stuck label state | Gap — workstream 6 |
| `onFinally` triggers workspace cleanup | Gap — workstream 6 |
| Ticking guard prevents concurrent ticks | Gap — workstream 6 |
| Fetch failure for one repo doesn't block other repos | Gap — workstream 6 |
| Multi-repo dispatch | Gap — workstream 6 |

### Orchestrator Reconcile (`core/orchestrator.ts`) — `orchestrator.reconcile.integration.test.ts`

| Behavior | Status |
|---|---|
| Kills agent when issue no longer has running label | Covered |
| Keeps agent running when label is still present | Covered |
| Reconcile skips repos with no running agents (avoids unnecessary API call) | Gap — workstream 6 |
| Reconcile handles fetch failure gracefully | Gap — workstream 6 |

### Workflow Cache (`core/workflow-cache.ts`) — `workflow-cache.integration.test.ts`

| Behavior | Status |
|---|---|
| Fetches and parses workflow from repo | Covered |
| Handles missing workflow file (404) | Covered |
| Keeps last-known-good on refresh failure (500) | Covered |
| Multi-repo refresh | Gap — workstream 6 |
| Parse failure (invalid YAML) keeps last-known-good | Gap — workstream 6 |

---

## Transitive Coverage Assessment

Modules below have no standalone tests. For each, I trace exactly which integration tests exercise them and flag where the transitive coverage has blind spots.

### GitHub Tracker Adapter (`core/trackers/github.ts`)

Exercised by orchestrator dispatch + reconcile tests via MSW.

| Behavior | Transitive Status | Notes |
|---|---|---|
| `fetchActiveIssues` maps GitHub response → `Issue[]` | Covered | orchestrator tests assert on `issueKey`, `agentName` derived from issue |
| `fetchActiveIssues` filters by authenticated user (`/user` → `creator` param) | Covered | MSW handles `/user` in every test |
| `fetchActiveIssues` deduplicates across active states | Not reached | tests use default `["open"]` state only |
| `fetchActiveIssues` multi-state fetch (`open` + `closed`) | Not reached | tests use default state only |
| `swapLabel` concurrent delete + post | Covered | orchestrator tests assert via `onLabelDelete`/`onLabelAdd` |

The dedup and multi-state logic is configuration-dependent. Low risk — only relevant if a consumer passes `activeStates: ["open", "closed"]`.

### GitHub Code Host Adapter (`core/code-hosts/github.ts`)

Exercised by orchestrator dispatch + workflow-cache tests via MSW.

| Behavior | Transitive Status | Notes |
|---|---|---|
| `fetchFile` base64 decodes content | Covered | workflow-cache test provides base64 content |
| `fetchFile` returns null on error | Covered | workflow-cache 404 test |
| `fetchFile` encodes path components | Covered | but only with simple paths |
| `fetchFile` supports `ref` parameter | Not reached | no test passes a ref |
| `cloneUrl` returns github URL | Covered | called during orchestrator dispatch, but value never asserted |
| `createChangeRequest` posts to pulls endpoint | Covered | orchestrator dispatch test asserts label swap after PR |

### Adapter Decorators (`core/trackers/decorator.ts`, `core/code-hosts/decorator.ts`)

Logging-only wrappers. No branching logic — they call the inner adapter, log the result, and return/re-throw. Exercised on every adapter call in integration tests. No standalone tests needed.

### Workspace (`core/workspace.ts`)

Called by orchestrator during dispatch. Tests pre-create the workspace directory via `createTestWorkspaceRoot().preCreateWorkspace()`, so `ensureWorkspace` hits the `access()` → exists → early return path in every test.

| Behavior | Transitive Status | Notes |
|---|---|---|
| `sanitizeKey` produces valid directory name | Covered | the pre-created dir name matches |
| `ensureWorkspace` returns existing workspace | Covered | every orchestrator test hits this path |
| `ensureWorkspace` creates new workspace (git clone) | Not reached | always pre-created |
| `ensureWorkspace` runs `after_create` hook | Not reached | `createTestWorkflow()` has no hooks |
| `removeWorkspace` deletes directory | Not reached | called in `onFinally` but never verified |

The git clone path is the most significant blind spot. It's untested because testing it requires a real git repo to clone from — heavier infrastructure than what the current test suite needs. Worth testing if workspace logic grows or becomes a source of bugs.

### Event Bus (`core/event-bus.ts`)

8-line `EventEmitter` wrapper (emit/on/off). Exercised by the runner (events are emitted on every lifecycle transition) but no test currently asserts on event bus emissions — assertions are via DB state. Would be tested if SSE streaming tests are added (workstream 5).

### GitHub Client (`core/gh.ts`)

Factory for the HTTP client. No logic to test. Consumed by adapters which are tested via MSW.

---

## Priority Summary

### High — gaps in core orchestration paths

| Gap | Workstream | Why it matters |
|---|---|---|
| `onComplete` failure doesn't corrupt run status | 4 | A throwing `onComplete` (PR creation fails) must not change status from "completed" to "failed" |
| Rollback label on workspace creation failure | 6 | Without this, a failed workspace leaves the issue claimed with no running agent |
| `onComplete` failure leaves label stuck at `agent:running` | 6 | Identifies a real production failure mode — issue never progresses |
| Fetch failure for one repo doesn't block others | 6 | `Promise.allSettled` resilience is load-bearing and untested |

### Medium — pure logic with untested edge cases

| Gap | Workstream | Why it matters |
|---|---|---|
| `renderPrompt` missing/null variables | 2 | Template rendering is used for branch names, prompts, and hooks — bad output means wrong branches or broken commands |
| `parseRepoWorkflow` defaults and validation | 2 | Incorrect defaults mean wrong branch names in production |
| `waitForIdle()` on queue | 1 | New method, relied on by entire test suite |
| `before_run` / `after_run` hook execution | 6 | Hooks are a user-facing feature with no test coverage |

### Low — edge cases with limited blast radius

| Gap | Workstream | Why it matters |
|---|---|---|
| `logAgentMessage` extraction and truncation | 3 | Affects dashboard display data, not correctness |
| SSE streaming endpoint | 5 | Requires testing long-lived streams |
| Kill returns false for unknown runId | 4 | One-line Map lookup |
| Multi-repo dispatch | 6 | Loop logic is straightforward |
| Tracker adapter dedup / multi-state | — | Only relevant with non-default `activeStates` config |
| Workspace git clone path | — | Requires heavier test infrastructure (local bare repo) |
