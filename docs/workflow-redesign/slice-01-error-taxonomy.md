# Slice 1 — Error taxonomy + prompt-scope types

## Read first

This slice doc, [`../migration-standards.md`](../migration-standards.md). No semantic-cases section applies — this slice introduces types only.

## What to build

Land the foundation types the engine speaks in:

- **5 tagged errors + 3 unions** in `workflow/errors.ts`. The split is the load/runtime divide — every public engine function returns errors from exactly one of these two buckets.
- **`PromptScope` / `PromptIssue`** in `workflow/types.ts` — the scope shape engine entrypoints take, replacing today's direct dependency on `trackers/Issue`. Drops `Issue.repo` (not in any template surface).
- **`StepUsage` / `ModelUsage`** in `workflow/types.ts` — the per-turn usage shape carried on `BranchResolved` / `StepResult` events later.

No engine behaviour changes in this slice. Existing call sites that already throw / catch on the soon-to-be-renamed errors update to the new tags. Existing call sites that consume `Issue` directly can keep doing so for now — the engine doesn't yet take `PromptScope` until slices 5 / 6 land.

The shapes (already locked — copy verbatim):

```ts
// workflow/errors.ts — 5 tagged errors + 3 unions
export class WorkflowParseError          extends Data.TaggedError("WorkflowParseError")<{ message: string }> {}
export class WorkflowValidationError     extends Data.TaggedError("WorkflowValidationError")<{ message: string }> {}
export class ShellExpansionError         extends Data.TaggedError("ShellExpansionError")<{ message: string }> {}
export class AgentTurnError              extends Data.TaggedError("AgentTurnError")<{ message: string; subtype?: string }> {}
export class StructuredOutputDecodeError extends Data.TaggedError("StructuredOutputDecodeError")<{ message: string; context: "step" | "branch" }> {}

export type WorkflowDefinitionError = WorkflowParseError | WorkflowValidationError;
export type WorkflowExecutionError  = ShellExpansionError | AgentTurnError | StructuredOutputDecodeError;
export type WorkflowError           = WorkflowDefinitionError | WorkflowExecutionError;
```

```ts
// workflow/types.ts
type PromptIssue = {
  key: IssueKey;
  number: IssueNumber;
  title: string;
  description: string;
  labels: readonly string[];
  url: string;
  createdAt: string;
};

type PromptScope = {
  issue: PromptIssue;
  baseBranch: string;
};

type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
};

type StepUsage = {
  costUsd: number;
  tokensInput: number;
  tokensOutput: number;
  modelUsage: Record<string, ModelUsage>;
};
```

## Acceptance criteria

- [ ] `workflow/errors.ts` exports the 5 tagged errors and 3 unions exactly as above.
- [ ] `workflow/types.ts` exports `PromptIssue`, `PromptScope`, `ModelUsage`, `StepUsage` with the shapes above.
- [ ] No `as` casts introduced. No Zod schemas added — use `effect/Schema` if any schema is needed.
- [ ] All existing call sites continue to compile; renamed errors propagate cleanly through current orchestrator code.
- [ ] `pnpm typecheck && pnpm test` green.

## Blocked by

None — can start immediately.
