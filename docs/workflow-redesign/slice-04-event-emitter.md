# Slice 4 — `WorkflowEventEmitter` Tag + `WorkflowEvent` ADT + Queue-backed Live layer

## What to build

The engine's contract with the outside world is a tagged-union event stream. This slice lands the contract; emission and consumption are wired up in later slices.

- `workflow/event-emitter.ts` — the `WorkflowEventEmitter` `Context.Tag`, the `WorkflowEvent` ADT (every tag from the prototype), and the `StepUsage` / `ModelUsage` types (already from slice 1).
- `workflow/event-emitter-live.ts` — `WorkflowEventEmitterLive(queue: Queue<WorkflowEvent>)` layer constructor. **Per-run** lifetime. The orchestrator owns the dequeue side via its event-consumer fiber (slice 8).

Tag shape:

```ts
interface WorkflowEventEmitter {
  readonly emit: (event: WorkflowEvent) => Effect<void>
}
```

Event ADT (full list — slice 5 emits the branch events, slice 6 emits the step events):

| Tag | Payload | Emitted from |
|---|---|---|
| `BranchAssistantMessage` | `{ message }` | `resolveBranch` |
| `BranchResolved` | `{ name, usage: StepUsage }` | `resolveBranch` |
| `BranchFailed` | `{ error: WorkflowExecutionError, usage: StepUsage }` | `resolveBranch` |
| `StepStarted` | `{ name, index, total }` | `runSteps` |
| `StepAssistantMessage` | `{ stepName, message }` | `runSteps` |
| `StepToolFailure` | `{ stepName, toolName }` | `runSteps` |
| `StepResult` | `{ stepName, structuredOutput?, sessionId, usage: StepUsage }` | `runSteps` |
| `StepCompleted` | `{ stepName, index, durationMs }` | `runSteps` |
| `StepFailed` | `{ stepName, index, error: WorkflowExecutionError, durationMs }` | `runSteps` |

## Acceptance criteria

- [ ] `WorkflowEvent` is a discriminated union with all 9 tags above.
- [ ] `WorkflowEventEmitter` is a `Context.Tag`.
- [ ] `WorkflowEventEmitterLive(queue)` returns `Layer<WorkflowEventEmitter>`; uses `Queue.offer` for emit.
- [ ] No emission sites yet — those land in slices 5 / 6.
- [ ] `pnpm typecheck && pnpm test` green.

## Blocked by

- Slice 1 (error taxonomy — `BranchFailed` / `StepFailed` carry `WorkflowExecutionError`)
