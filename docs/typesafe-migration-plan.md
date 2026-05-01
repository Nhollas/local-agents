# Living Implementation Plan: Typesafe Migration

This is the execution plan for bringing `server/` in line with [coding-standards.md](./coding-standards.md). Each slice is one conceptual change, cuts across whichever modules it needs to, and lands as its own reviewable PR.

Keep this document current as implementation proceeds. Update a slice before changing code if scope shifts. Record verification commands when a slice completes.

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
- Add or update focused tests in the same layer as the behavior being changed.
- Not change runtime behavior. These are type-level refactors. If a slice has to change behavior to land, split it.
- Pass `pnpm lint`, `pnpm typecheck`, and `pnpm test` before being marked ready for review.

## Sequencing

Slices 1 → 4 are sequential. Each unblocks the next:

- Slice 1 introduces the primitives (brands, `Result`, `assertNever`) that later slices use.
- Slice 2 brands the values that ripple through every module; doing this before slice 3+ means later slices already see the right types at boundaries.
- Slice 3 reshapes `Run` state, which slice 4 depends on for parsing.
- Slice 4 parses at the DB boundary; needs slice 3's union shape to parse into.

Slice 6 is cleanup and can run in parallel with anything once 1–4 are done.

## Slice 1 — Type Foundations

**Status:** Ready for review

**Started:** 2026-04-30.

**Completed changes:**

- Added `server/types/brands.ts` exporting `Brand<T, Name>`. Concrete brand constructors (validating ones returning `Result`, unchecked ones at trusted boundaries) are written per-brand in Slice 2 — the originally planned generic `unsafeBrand` helper was dropped because TS's intersection-type inference makes a sound generic version impossible without forcing two explicit type arguments at every call site.
- Added `server/types/result.ts` exporting `Result<T, E>`, `Ok<T>`, `Err<E>`, `ok`, `err`, `map`, `mapErr`, `unwrap`.
- Added `server/types/exhaustive.ts` exporting `assertNever`.
- Re-exported all three from `server/types/index.ts`.
- Added unit tests in `server/types/__tests__/` for `Result` helpers, `assertNever`, and the validating brand constructor pattern.

**Verification:**

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:coverage` — 100% across the board, `server/types/` included.

**Purpose:** Add the primitives the rest of the migration depends on. Pure additions, no call sites updated.

**Scope:**

- Add `server/types/brands.ts` with `Brand<T, Name>`. Concrete validating/unchecked constructors land alongside their brands in Slice 2.
- Add `server/types/result.ts` with `Result<T, E>`, `ok`, `err`, and minimal helpers (`map`, `mapErr`, `unwrap`).
- Add `server/types/exhaustive.ts` with `assertNever(x: never): never`.
- Re-export from `server/types/index.ts`.

**Natural code areas:**

- `server/types/` (new directory)

**Quality gates:**

- No existing call sites updated in this slice.
- Unit tests cover `Result` helpers, `assertNever`, and the validating brand constructor pattern.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## Slice 2 — Brand the Rippling Primitives

**Status:** Ready for review

**Started:** 2026-04-30 on branch `refactor/typesafe-slice-2-brand-primitives`.

**Completed changes:**

- Added concrete brands and unchecked constructors to `server/types/brands.ts`: `RepoSlug`, `IssueKey`, `IssueNumber`, `BranchName`, `RunId`, `GitHubToken`, `GitLabToken`, `JiraApiToken`, `JiraEmail`.
- Construction at boundaries: `config.ts` brands repo slugs via Zod `.transform`; `env.ts` brands tokens/email after Zod validation; `api/api.ts` brands run id via Zod `.transform`; tracker adapters brand `Issue.key` and parsed `repo`/`number`.
- Updated signatures across `code-hosts/`, `trackers/`, `orchestrator/`, `runner/`, `api/`, `db/`, `event-bus.ts`, `workflow/workflow-loader.ts` to use brands. `tsc` drove the diff.
- Tracker `parseIssueKey` now returns `Result<{ repo: RepoSlug; number: IssueNumber }, ParseIssueKeyError>` rather than throwing; orchestrator unwraps at call sites because input there comes from internal DB state.
- Test helpers (`test-db.ts`, `test-orchestrator.ts`, `test-config.ts`, `fixtures.ts`) brand internally so tests still pass loose strings to `seedRun`/`seedEvent`. Tests that call production APIs directly (`runner.enqueue`, `orchestrator.retryRun`, `runner.kill`, HTTP clients, code-host adapters, tracker adapters) brand at the call site.
- Tracker `parseIssueKey` tests rewritten to assert `Result` shape rather than throws.
- `mapJiraIssue` defensive null-check covered with a `/* v8 ignore */` pragma — it can only fire if Jira returns keys outside its own search filter, which the schema parses anyway.

**Verification:**

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:coverage` — 100% across all `server/` files.

**Purpose:** Replace primitive-typed parameters across `server/` with branded types, so the compiler enforces what is currently developer-remembered.

**Scope:**

- Brand: `RepoSlug`, `IssueKey`, `BranchName`, `GitHubToken`, `GitLabToken`, `JiraApiToken`, `JiraEmail`, `RunId`, `IssueNumber`.
- Construct at boundaries: `config.ts` (tokens, repo slugs), `env.ts` (tokens, email), API request parsers (issue keys, run ids), tracker `parseIssueKey` returns `IssueKey`.
- Update signatures across `code-hosts/`, `trackers/`, `orchestrator/`, `runner/`, `api/`, `db/` to use brands. Let `tsc` drive the diff.
- Tracker `parseIssueKey` returns `Result<{ repo: RepoSlug; number: IssueNumber }, ParseIssueKeyError>` rather than throwing; this is the only behavior change permitted in this slice and is required because we need a brand-returning parser.

**Natural code areas:**

- `server/config.ts`, `server/env.ts`
- `server/code-hosts/*`, `server/github-client.ts`, `server/gitlab-client.ts`
- `server/trackers/*`, `server/jira-client.ts`
- `server/orchestrator/*`, `server/runner/*`
- `server/api/*`
- `server/db/schema.ts`, `server/run-repository.ts`

**Quality gates:**

- No `string`-typed parameters remain for repo slugs, issue keys, branch names, tokens, run ids, issue numbers.
- Tracker tests assert `parseIssueKey` returns `Result`, not throws.
- Existing behavior tests still pass unchanged.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## Slice 3 — Discriminate `Run` State

**Status:** Ready for review

**Started:** 2026-04-30.

**Completed changes:**

- Replaced `Run = typeof runs.$inferSelect` in `server/run-repository.ts` with a discriminated union: `RunningRun | CompletedRun | FailedRun`. Each variant carries only the fields that are valid in that state (e.g. `running` has no `completedAt`/`durationMs`/`error`; `completed` requires `completedAt` and `durationMs`; `failed` requires `completedAt` and `error`, with `durationMs: number | null` because stale-run reconciliation fails without one).
- Added `rowToRun` projection at the repository edge. `getRunById` and `getRuns` now parse rows into the union; mixed-state rows throw an invariant error rather than being returned. The exhaustive switch on `row.status` ends in `assertNever`.
- `getRunningSnapshot` keeps its narrow `{ id, issueKey }` projection — it already filters on `status = "running" AND issueKey IS NOT NULL`, so it bypasses the union mapping intentionally.
- DB schema is unchanged. Drizzle columns stay nullable; the row/union mismatch lives entirely inside the repository.
- `server/api/api.ts` adds a `runToWire` projection back to the existing wide JSON shape so the API contract is unchanged. Both `/runs` and `/runs/:id` go union → wire. Exhaustive switch ends in `assertNever`.
- Orchestrator `retryRun` already used early-return on `failedRun.status !== "failed"`; the union just makes that narrowing real — `failedRun` is a `FailedRun` after the guard, no other code changes needed.
- `seedRun` test helper now auto-fills variant-required fields (`completedAt`/`durationMs` for completed; `completedAt`/`durationMs`/`error` for failed) so tests can seed by status without restating the invariants.
- New `server/__tests__/run-repository.test.ts` covers the projection: invariant throws for malformed completed/failed rows and the failed-run round-trip. New API test asserts the failed-run wire shape.

**Verification:**

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:coverage` — 100% across all `server/` and `dashboard/` files.

**Purpose:** Make impossible run states unrepresentable. Replace the optional-field bag (`status` plus optional `error`, `completedAt`, etc.) with a tagged union at the repository boundary.

**Scope:**

- Define `Run` as `{ status: "pending", … } | { status: "running", … } | { status: "completed", completedAt, … } | { status: "failed", error, failedAt, … }` in the domain layer.
- Keep the DB schema as-is (Drizzle columns stay nullable). Wrap rows at the repository edge: parse on read, project on write. The repository is the only place that knows about the row/union mismatch.
- Update orchestrator state transitions to operate on the union. Replace any `if (run.status === "running") { … run.error … }` with exhaustive narrowing.
- Add `assertNever` in any `switch`/discriminant branch that handles the union.

**Natural code areas:**

- `server/db/schema.ts` (no migration; column shape unchanged)
- `server/run-repository.ts`
- `server/orchestrator/*`
- `server/api/*` (response shapes consume the union)

**Quality gates:**

- Repository never returns a `Run` with mixed-state fields.
- Every `switch`/branch on `run.status` is exhaustive, verified by `assertNever`.
- API response shape is unchanged or only widens (no client breakage).
- `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## Slice 4 — Parse at the DB Boundary

**Status:** Not started

**Purpose:** Same discipline as the HTTP clients, applied to the database. Drizzle gives compile-time types but no runtime guarantee against schema drift, manual edits, or migration bugs.

**Scope:**

- Add Zod schemas for every row shape returned by `run-repository.ts`. Parse on read, including `getRunningSnapshot`.
- Replace `RunEvent`'s `Record<string, unknown>` payload with a `z.discriminatedUnion("type", […])` schema in `db/schema.ts` (or a new `db/events.ts`). Infer the type via `z.infer`.
- Use the inferred event type in `event-bus.ts` and consumers.
- Parsing failures throw — these are invariant violations, not expected failures, because the DB is internal.

**Natural code areas:**

- `server/db/schema.ts` or new `server/db/events.ts`
- `server/run-repository.ts`
- `server/event-bus.ts`
- Any consumer of `RunEvent` data

**Quality gates:**

- All repository read paths parse before returning.
- `RunEvent` data is a single inferred type with no hand-maintained duplicates.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## Slice 5 — API Errors as Values (dropped)

**Status:** Dropped 2026-05-01.

**Why dropped:** The existing pattern (route throws `ProblemDetailsError`, single `onError` handler converts it to an RFC 9457 response) is already errors-as-values in everything but syntax. Conversion to `return problemResponse(c, ...)` is purely cosmetic — same status codes, same response shapes, same control flow. A trial implementation also forced an `as unknown as Context<AppEnv>` cast in the helper because `@hono/zod-validator`'s `Hook` binds `Env` looser than `AppEnv`, which is a regression the slice was supposed to avoid. The "errors as values" wins are already realised by slices 1–3 (branded types, `Run` discriminated union, `parseIssueKey` returning `Result`). `ProblemDetailsError` stays as the route → handler bridge.

## Slice 6 — Cleanup Pass

**Status:** Ready for review

**Started:** 2026-05-01.

**Completed changes:**

- `server/workflow/workflow.ts`: Folded the `prompt | phases` shorthand into a single Zod schema with a `.transform()` that normalizes both YAML shapes into a `phases` array at the boundary. `RepoWorkflow` is now `z.infer<typeof repoWorkflowSchema>` — no hand-written duplicate. Dropped `getWorkflowPhases` (callers read `workflow.phases` directly), removed `prompt as string` and the `value as Record<string, unknown>` cast in `renderPrompt` (now uses an `isRecord` type predicate). `NonEmptyArray<WorkflowPhase>` was considered and dropped — no caller indexes phases (only `.length`/`.entries()`), so per the standards it is non-load-bearing type machinery.
- `server/orchestrator/phase-runner.ts`: Reads `workflow.phases` directly. Added a guard that throws if `startPhaseIndex` is out of range for the configured phases — the invariant could otherwise silently fail when stored DB state predates a config change.
- `server/workflow/prompt-preprocessor.ts`: Removed `match[1] as string` and `outputs[i++] as string`. Both call sites now check for `undefined` and throw an unreachable-invariant error documented with a `/* v8 ignore */` pragma.
- `server/api/problem-details.ts`: `zodProblemHook` now derives validation errors from `result.error.issues` directly, dropping the `messages as string[]` cast and the `flattenError` round-trip.
- `server/orchestrator/orchestrator.ts`: Tightened tick-state types — `runningByIssue: Map<IssueKey, RunId[]>` and `stillRunning: Map<RepoSlug, Set<IssueKey>>` (was `string` keyed). Removed the `i.key as string` widening cast.
- `server/run-repository.ts`: `getRunningSnapshot` now narrows via a `filter` with a typed predicate rather than asserting through `as`.
- `server/trackers/jira.ts`: `extractText` uses `in`-based narrowing instead of casting through `Record<string, unknown>`.
- `server/runner/runner.ts`: Documented the lone remaining `as RunEvent` cast — a TS limitation when recombining a discriminated union through a spread. `EventPayload` is the distributive `Pick<RunEvent, "type" | "data">`, so the runtime invariant is intact.
- Added `server/orchestrator/__tests__/phase-runner.test.ts` covering the new `startPhaseIndex` invariant in both directions (negative and past-last-phase).
- Updated test fixtures (`createTestWorkflow`) and the few tests that constructed `RepoWorkflow` literals with the old `prompt` shorthand to use the normalized `phases` form.

**Verification:**

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:coverage` — 100% across all `server/` and `dashboard/` files.

**Surviving `as` casts under `server/` (all documented post-narrowing assertions):**

- `server/types/brands.ts` — Brand constructors at trusted boundaries (slice 1/2 design).
- `server/run-repository.ts` `rowToRun` — exhaustive switch ends in `assertNever` (slice 3 design).
- `server/runner/runner.ts` `as RunEvent` — see above.

**Purpose:** Sweep the remaining items the earlier slices did not naturally fix.

**Scope (executed):**

- Remove unchecked `as` casts in `server/workflow/workflow.ts` and `server/workflow/prompt-preprocessor.ts`.
- Encode workflow phase invariants: `phases` always defined post-parse via Zod transform; `startPhaseIndex` validated at runtime against the array.
- Drop the `messages as string[]` cast in `server/api/problem-details.ts`.
- Final scan with `rg -n '\bany\b|\bas \b|@ts-ignore|@ts-expect-error'` under `server/` (excluding `as const`); document survivors.

**Natural code areas:**

- `server/workflow/*`
- `server/api/problem-details.ts`
- `server/orchestrator/*`, `server/run-repository.ts`, `server/trackers/jira.ts`
- `server/runner/runner.ts`

**Quality gates:**

- No `any`, no `@ts-ignore`/`@ts-expect-error`, no unchecked `as` outside `as const` and the documented post-narrowing assertions listed above.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## Release-Level Acceptance

The migration is complete when:

- Every standard in `coding-standards.md` is enforced across `server/` with no documented exceptions.
- `pnpm typecheck` passes with no escape hatches anywhere under `server/` (excluding tests, which may relax some rules where pragmatic).
- Test coverage is at or above the level recorded at the start of slice 1.
- Boundaries (config, env, HTTP, DB, API request bodies, child-process output) all parse rather than trust.
