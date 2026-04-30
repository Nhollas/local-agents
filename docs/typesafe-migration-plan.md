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

Slices 1 → 5 are sequential. Each unblocks the next:

- Slice 1 introduces the primitives (brands, `Result`, `assertNever`) that later slices use.
- Slice 2 brands the values that ripple through every module; doing this before slice 3+ means later slices already see the right types at boundaries.
- Slice 3 reshapes `Run` state, which slices 4 and 5 depend on for parsing and API responses.
- Slice 4 parses at the DB boundary; needs slice 3's union shape to parse into.
- Slice 5 converts API throws to returns; cleaner once slice 3 has tightened the shape it returns.

Slice 6 is cleanup and can run in parallel with anything once 1–5 are done.

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

**Status:** Not started

**Purpose:** Replace primitive-typed parameters across `server/` with branded types, so the compiler enforces what is currently developer-remembered.

**Scope:**

- Brand: `RepoSlug`, `IssueKey`, `BranchName`, `GitHubToken`, `GitLabToken`, `JiraApiToken`, `JiraEmail`, `RunId`, `IssueNumber`.
- Construct at boundaries: `config.ts` (tokens, repo slugs), `env.ts` (tokens, email), API request parsers (issue keys, run ids), tracker `parseIssueKey` returns `IssueKey`.
- Update signatures across `code-hosts/`, `trackers/`, `orchestrator/`, `runner/`, `api/`, `db/` to use brands. Let `tsc` drive the diff.
- Tracker `parseIssueKey` returns `Result<IssueKey, ParseError>` rather than throwing; this is the only behavior change permitted in this slice and is required because we need a brand-returning parser.

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

**Status:** Not started

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

## Slice 5 — API Errors as Values

**Status:** Not started

**Purpose:** Stop using `throw` for expected API failures. 404, validation, and state-conflict responses are routine outcomes, not invariant violations.

**Scope:**

- Audit `server/api/*` routes for `throw new ProblemDetailsError(...)` in expected paths.
- Convert each to a returned response (`return c.json({...}, status)`).
- Keep `ProblemDetailsError` and the global handler for genuine invariant violations / 500s only.
- Where a route reads from the repository and may need to 404, the repository returns `Result<Run, NotFound>` (or similar); the route maps that to a response.

**Natural code areas:**

- `server/api/*`
- `server/api/problem-details.ts`
- `server/run-repository.ts` (signature changes for find-style reads)

**Quality gates:**

- No expected failure paths throw.
- Existing route tests still pass with same response shapes.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## Slice 6 — Cleanup Pass

**Status:** Not started

**Purpose:** Sweep the remaining items the earlier slices did not naturally fix.

**Scope:**

- Remove unchecked `as` casts in `server/workflow/workflow.ts` (`prompt as string`, etc.) and `server/workflow/prompt-preprocessor.ts` (`match as RegExpExecArray`). Use control-flow narrowing or small assertion helpers.
- Encode workflow phase invariants: `phases` as `NonEmptyArray<Phase>`, `startPhaseIndex` valid against the array.
- Audit `server/api/problem-details.ts` for the `messages as string[]` cast.
- Final scan with `rg -n '\bany\b|\bas \b|@ts-ignore|@ts-expect-error'` under `server/` (excluding `as const`); document any survivors with a justification or fix them.

**Natural code areas:**

- `server/workflow/*`
- `server/api/problem-details.ts`
- Anywhere flagged by the final sweep.

**Quality gates:**

- No `any`, no `@ts-ignore`/`@ts-expect-error`, no unchecked `as` outside `as const` and post-narrowing assertions.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## Release-Level Acceptance

The migration is complete when:

- Every standard in `coding-standards.md` is enforced across `server/` with no documented exceptions.
- `pnpm typecheck` passes with no escape hatches anywhere under `server/` (excluding tests, which may relax some rules where pragmatic).
- Test coverage is at or above the level recorded at the start of slice 1.
- Boundaries (config, env, HTTP, DB, API request bodies, child-process output) all parse rather than trust.
