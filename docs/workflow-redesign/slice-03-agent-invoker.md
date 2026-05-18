# Slice 3 — `AgentInvoker` Tag + Live layer relocated into `workflow/`

## Read first

This slice doc, [`../migration-standards.md`](../migration-standards.md). No semantic-cases section applies — this is a relocation, not a behaviour change.

## What to build

Move agent invocation into the workflow module per ADR 0002. After this slice, the workflow engine *owns* agent invocation; the orchestrator no longer has any agent-invoker code.

- `workflow/agent-invoker.ts` — the `AgentInvoker` `Context.Tag` plus the `AgentInvokeOptions` and `AgentMessage` types it speaks.
- `workflow/agent-invoker-live.ts` — `AgentInvokerLive({ logDir, env })` layer constructor, backed by the Claude Agent SDK. **Per-run** lifetime. Not part of `WorkflowLayer`.
- `workflow/agent-hooks.ts` — SDK hook callbacks (relocated from `orchestrator/agent-hooks.ts`, content preserved).
- `workflow/run-log-file.ts` — per-run agent transcript writer (relocated from `orchestrator/run-log-file.ts`, content preserved).

Delete the old `orchestrator/agent-invoker.ts`, `orchestrator/agent-hooks.ts`, `orchestrator/run-log-file.ts`. Their tests (`agent-hooks.test.ts`, `run-log-file.test.ts`) move with them — update import paths only, don't rewrite assertions.

The Tag shape (from the prototype):

```ts
interface AgentInvoker {
  readonly invoke: (opts: AgentInvokeOptions) => AsyncIterable<AgentMessage>
}
```

The Live constructor takes `{ logDir, env }` per-run (one per workflow run, because each run gets its own log directory and env).

## Acceptance criteria

- [ ] Engine code never imports anything from `orchestrator/` for agent invocation.
- [ ] `AgentInvoker` is a `Context.Tag`, not a hand-written interface threaded through function parameters.
- [ ] `AgentInvokerLive({ logDir, env })` returns a `Layer<AgentInvoker>`.
- [ ] Existing `step-runner.ts` and `branch-resolver.ts` adapted to consume the Tag (provisional bridge — they go away in slices 5/6). Acceptable to keep their imperative shape for this slice; the goal is just the relocation + Tag conversion.
- [ ] No `as` casts, no Zod, no interface wrappers obscuring Effect signatures.
- [ ] `agent-hooks.test.ts` and `run-log-file.test.ts` pass at their new paths under `workflow/`.
- [ ] `pnpm typecheck && pnpm test` green.

## Blocked by

- Slice 1 (error taxonomy — `AgentTurnError` is the failure channel for `invoke`)
