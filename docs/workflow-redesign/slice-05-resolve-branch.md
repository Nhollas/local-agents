# Slice 5 — `resolveBranch` via `runAgentTurn` (delete `branch-resolver.ts`)

## What to build

First workflow phase converted end-to-end. Land:

- `workflow/run-agent-turn.ts` — **private** shared one-turn primitive used by both `resolveBranch` and `runSteps` (slice 6). Not exported from the module index.
- `workflow/resolve-branch.ts` — public `resolveBranch` entrypoint. Either zero turns (literal branch template) or exactly one `runAgentTurn` call (dynamic form).
- Delete `server/orchestrator/branch-resolver.ts`.
- Update `run-lifecycle.ts` to call `engine.resolveBranch(workflowBranch, scope)` directly with `Effect.provide(perRunLayers)`.

`runAgentTurn` signature (from the prototype — keep this verbatim):

```ts
runAgentTurn: (input: {
  prompt: string;
  model: ModelId;
  outputSchema: JsonSchemaDocument;     // required — both callers always have one
  allowedTools?: readonly string[];
  resumeSessionId?: string;
  shellExpansion?: { cwd: string; env: Record<string, string> };   // opt-in
  emitAs:
    | { kind: "branch" }
    | { kind: "step"; name: string; index: number; total: number };
}) => Effect<{
  structuredOutput: unknown;
  sessionId: string;
  usage: StepUsage;
}, WorkflowExecutionError, AgentInvoker | WorkflowEventEmitter | CommandExecutor | FileSystem>
```

`resolveBranch` signature:

```ts
resolveBranch: (workflowBranch: WorkflowBranch, scope: PromptScope)
  => Effect<string, WorkflowExecutionError, AgentInvoker | WorkflowEventEmitter | CommandExecutor | FileSystem>
```

Event emission per the table in slice 4: `BranchAssistantMessage` during the stream, `BranchResolved` on success, `BranchFailed` on failure (with usage still populated if the result message arrived).

The semantics that must survive are listed in [`semantic-cases.md`](semantic-cases.md) under "Slice 5".

## Acceptance criteria

- [ ] `resolveBranch` consumes `AgentInvoker` + `WorkflowEventEmitter` via Service Tags — no parameter injection.
- [ ] Literal branch template path makes zero `runAgentTurn` calls and still emits `BranchResolved`.
- [ ] Dynamic branch form passes `outputSchema` to the invoker and decodes the structured output.
- [ ] All semantic cases listed under "Slice 5" in `semantic-cases.md` are covered by new tests asserting on event sequences + return value + error tags. Not by porting old `agent.calls[i]` assertions.
- [ ] `orchestrator/branch-resolver.ts` deleted.
- [ ] `run-lifecycle.ts` calls the engine directly; no bridging shim.
- [ ] No `as` casts, no Zod, no interface wrappers — see `migration-standards.md`.
- [ ] `runAgentTurn` is private (not in any module index/barrel).
- [ ] `pnpm typecheck && pnpm test` green.

## Blocked by

- Slice 3 (`AgentInvoker`)
- Slice 4 (`WorkflowEventEmitter`)
