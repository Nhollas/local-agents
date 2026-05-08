# Server Audit

Scope: `server/` — architecture, code quality, testing.
Date: 2026-05-08.

## Top-line verdict

The bones are good. The TrackerAdapter / CodeHostAdapter split, fixed lifecycle pins, AsyncLocalStorage canonical-log, MSW-backed integration tests, and the runner/queue separation are all well-considered. Type-safety is genuinely strict (`exactOptionalPropertyTypes`, branded primitives, discriminated `Run` union) and you actually use it.

## Architecture findings

### Low — `getDb` is a hidden global

`server/db/db.ts:8-9` is module-level mutable. Tests use `createTestDb` so the global only matters for the actual entrypoint, but threading the db through `server.ts` is two more lines and removes the singleton.

### Low — Adding a new code host requires 5 edits across 3 files

New client, new adapter, new branch in `create-code-host.ts`, new auth in `env.ts`, new `requireToken` line. Acceptable for two hosts, would tip annoying at four. A registry table keyed by `code_host.kind` would collapse it. **Don't refactor until you actually add a third.**

## Code quality findings

### Med — `as unknown as AgentMessage` casts scattered through tests

`branch-resolver.test.ts:146`, `step-runner.test.ts:135,173,396`. The SDK's `AgentMessage` is heavy; the casts work around shape mismatches. Acceptable for the scripted-message helpers, but the cast should live in one place.

**Action:** extract a `buildAgentMessage` factory in `testing/support/`.

### Med — `extractText` in `server/trackers/jira.ts:157` silently returns `""`

For unrecognised description shapes. Combined with `description: z.unknown().nullable().optional()` in `jira-client.ts:8`, the issue description is effectively typed `unknown` and gets normalised by recursion. If a Jira ADF shape changes, you'll silently get empty descriptions in agent prompts.

**Action:** `canonicalLog.append("warnings", ...)` on the unrecognised-object branch.

### Med — `errorMessage` in `canonical-log.ts:7` is trivial indirection

It's literally `err instanceof Error ? err.message : String(err)`, exported and used in many places, with a dedicated test block. Inline it.

### Med — `addToMapEntry` silently overwrites non-map values

`canonical-log.ts:84` — if an existing non-map value sits at the key, it gets clobbered. For a structured logger, a `console.warn` or throw on type collision would surface instrumentation bugs.

### Low — Module layout violation

`prompt-preprocessor.ts:52-56` puts constants and regexes in the middle between public functions and private helpers. Per the "public types/interface and main implementation at top, private helpers at bottom" rule, move them to the bottom or next to consumers.

### Low — `noopAgent` / `hangingAgent` shoehorned through `adaptRunAgent`

`fixtures.ts:79-83` returns `AsyncIterable<AgentMessage>` and gets adapted via `adaptRunAgent` (`fixtures.ts:16`) which builds a fake `AgentInvoker` from a `query`-shaped function. Leftover scaffolding from an earlier API.

**Action:** make these direct `AgentInvoker` instances; remove `LegacyRunAgent` and the adapter.

### Low — `agent-logging.ts:19` index access for tool-input fields

`String(block.input["pattern"] ?? block.input["file_path"] ?? block.input["command"] ?? "")` — three string keys with `noPropertyAccessFromIndexSignature` disabled. A typed `ToolUseInput` discriminator (or a small per-tool extractor map) would express intent.

## Testing findings

### High — Layering overlap between orchestrator integration tests and step-runner unit tests

`orchestrator.scheduling.integration.test.ts` verifies dispatch ordering (good) but the multi-repo dispatch test runs the full branch-resolve → ensureBranch → runRepoSetup → step-runner pipeline. Unit tests for the same paths exist and are thorough.

**Action:** narrow the integration layer to tracker→repo→runner DB shape, lifecycle pin order, and reconciliation. Don't re-run step-runner logic at this level.

### High — `jira.integration.test.ts` JQL-shape duplication

Several cases test the same underlying behaviour: `fetchActiveIssues`'s JQL building has 6 cases that pull the same Jira-search-handler fixture. Half belong as unit tests against a fake `JiraClient`, with one or two integration tests confirming wire shape end-to-end.

### Med — `runner.integration.test.ts` overlaps `queue.test.ts`

FIFO ordering and capacity (`queue.test.ts:73-97`) are unit-level and complete. `runner.integration.test.ts:75-119` ("records a running status even when at capacity") exercises queue-pending behaviour the queue tests already own.

**Action:** assert the DB row at the runner level, not queue state.

### Med — Two `toEqual` softspots

- `orchestrator.scheduling.integration.test.ts:22` uses `toMatchObject` instead of `toEqual` — partial matches hide drift.
- `step-runner.test.ts:226-229` checks `recorder.stepEvents.map((e) => e.type)` instead of full event shapes.

### Med — Inconsistent test data names

`acme/widgets` (good, matches the rule) mixed with `owner/repo` and `test-owner/test-repo` across `branch-resolver.test.ts:17`, `step-runner.test.ts:69,73`, `runner.integration.test.ts:46,...`.

**Action:** standardise on `acme/widgets` everywhere.

### Med — Mocking discipline is good

No `vi.mock`. Only one `vi.fn` (an emit-callback in `agent-logging.test.ts`). `vi.useFakeTimers()` in `orchestrator.scheduling.integration.test.ts:122,146` is fine. Scripted `AgentInvoker` factories (`createAgent` in `step-runner.test.ts:107`) are explicit in-test with no module mocks. **Keep this pattern.**

### Low — `seedRun`'s `LooseRunInsert` accepts dead `parentRunId`

`test-db.ts:17` — concession to a removed feature. Drop it.

### Low — Coverage gap that matters

No test exercises `orchestrator.start()`'s recovery-then-tick startup race (`orchestrator.ts:222-236`). Recovery and tick are tested separately, but the actual production startup path is only covered by the polling-interval test, which doesn't add a tracker issue. If `recover()` throws, the catch logs and the interval still gets set — reasonable, but untested.

### Low — `prompt-preprocessor.test.ts` spawns real shells

Timeout-and-buffer-overflow paths (lines 52-104 of the source) are integration territory. Today it works, but flake risk on CI. Consider faking `spawn` for the error-message assertions.

## Top remaining changes by leverage

1. **Collapse the `fixtures.ts` `adaptRunAgent` / `LegacyRunAgent` shim.** Make `noopAgent` / `hangingAgent` direct `AgentInvoker` instances; remove `LegacyRunAgent` and its `QueryParams` re-derivation. SDK boundary appears once (in `claudeSdkAgentInvoker`).
2. **Trim `jira.integration.test.ts` and `orchestrator.scheduling.integration.test.ts`.** Pull JQL-shape cases into a unit test against a fake `JiraClient`; keep one wire-shape integration. In the orchestrator file, drop tests that duplicate `step-runner.test.ts` behaviour and keep dispatch/scheduling/lifecycle-pin tests.
3. **Standardise test data on `acme/widgets`** across branch-resolver, step-runner, and runner integration tests.
4. **Inline `errorMessage` from `canonical-log.ts`** — trivial indirection used in many places.
5. **Add a startup-race test for `orchestrator.start()`** covering recovery-then-tick with a tracker issue present.
