# Workflow engine owns all agent invocation

- **Status:** Accepted
- **Date:** 2026-05-18

> In the context of *redesigning `server/workflow/` during the Effect migration*, facing *agent-invocation logic scattered across the orchestrator and a workflow module that was a grab-bag of utilities*, we decided to *make the workflow engine the sole owner of agent invocation — including the Claude Agent SDK-backed `AgentInvoker` Live layer, the SDK hook callbacks, and the per-run agent transcript writer* — to achieve *one coherent home for "anything to do with workflow.yaml", and a narrow public contract per phase*, accepting *that the engine module grows to ~18 files and that orchestrator files which today bridge SDK messages to dashboard events must be deleted or refactored*.

## Context

`server/workflow/` started as a definition module — load, parse, validate `workflow.yaml`. Execution-time concerns crept in: prompt rendering, shell-block expansion, and three orchestrator files (`step-runner.ts`, `branch-resolver.ts`, `change-request-renderer.ts`) each reached into workflow internals to run agents and render templates. The result:

- Workflow's public surface was seven loosely-related functions, not one contract.
- `workflow/render-prompt.ts` imported `Issue` from `trackers/` — a layering inversion.
- The "workflow engine" described in `docs/architecture.md` was split across two modules; the doc no longer matched the code.
- The same agent-invoke loop (cost/token accumulation, structured-output decode, assistant-message dispatch) appeared in both `step-runner.ts` and `branch-resolver.ts`.
- `orchestrator/agent-logging.ts` existed only to bridge raw SDK messages into dashboard events — a seam that would not exist if the engine emitted typed events directly.

The Effect migration was already in progress for `code-hosts/` and `trackers/`, both of which had been reshaped around a narrow public contract (`CodeHostAdapter`, `TrackerAdapter`) with everything else converging on it. `workflow/` was the next module due for the same treatment, but its shape is not an adapter — it does not abstract one of many providers.

## Decision drivers

- "Anything to do with the workflow lives in the workflow module" — a working rule for where each concern belongs.
- Branch resolution, step execution, and change-request rendering are sibling **phases** of a workflow, not unrelated concerns.
- The Effect migration favours Service Tags + Layers over imperative dependency injection.
- The architecture doc must describe the code as it is, not aspirationally.
- Test surface should expand the right things: per-phase behaviour, event sequences, error tags.

## Decision

The `server/workflow/` module becomes the **workflow engine** and owns:

- Definition: `loadWorkflow`, the parser, and the validator (now generalised across all four template surfaces — `branch.agent.prompt`, every `steps[N].prompt`, and both `change_request.{title, body}`).
- Execution: `resolveBranch`, `runSteps`, and `renderChangeRequest`. One public function per workflow phase.
- A private one-turn primitive (`runAgentTurn`) on which both `resolveBranch` and `runSteps` are built.
- Two Service Tags (`AgentInvoker`, `WorkflowEventEmitter`) that the engine consumes, plus the per-run Live Layer constructors that satisfy them. The Claude Agent SDK-backed `AgentInvokerLive` lives in `workflow/`, alongside the SDK hook callbacks and the per-run transcript writer it uses.
- A `WorkflowEvent` tagged union — the public contract by which the engine reports progress and the orchestrator reacts (run repository writes, SSE for the dashboard, canonical log, telemetry spans, post-step diff measurement).

Errors are two-bucket — `WorkflowDefinitionError` (load-time) and `WorkflowExecutionError` (runtime) — so each entrypoint's error channel tells the truth about what can fail where.

The orchestrator keeps a much smaller surface around the engine: a `run-lifecycle.ts` that composes the engine functions, an `event-consumer.ts` fiber that drains the per-run event queue, and the existing run repository / workspace / scheduling code. Three orchestrator files delete (`step-runner.ts`, `branch-resolver.ts`, `change-request-renderer.ts`), two more collapse into `event-consumer.ts` (`agent-logging.ts`, `agent-metrics.ts`), and three move into `workflow/` (the SDK-backed invoker, its hooks, and the run-log writer).

## Considered alternatives

- **Keep the grab-bag, just rename for consistency.** Rejected because it leaves the public surface as a list of seven loose functions and preserves the layering inversion. The reference modules (`code-hosts/`, `trackers/`) earned their clarity from a narrow contract; doing less here would re-introduce the same drift in six months.
- **Engine owns prompt rendering only; `step-runner.ts` stays in orchestrator.** Rejected because it leaves `markTrustedShellBlocks → renderPrompt → expandMarkedShellBlocks` as three public verbs the orchestrator has to choreograph in the correct order, and leaves the agent-invoke loop duplicated between step and branch execution.
- **Engine owns `runStep` (single step); orchestrator owns the steps loop.** Rejected because `resume_previous` (session-id threading) and `steps.<name>.output` (output-feeds-next-prompt) are the defining semantics of a workflow — both belong on the engine side of the boundary.
- **Interface in `workflow/`, SDK-backed Live layer in `orchestrator/`.** Rejected because the hexagonal split only earns its keep when implementations vary by deployment context. They do not here — the SDK-backed invoker is the production implementation, and tests provide stub Tags directly. The split was unprincipled and contradicted the working rule that all agent-invocation code lives with the workflow.
- **`Stream<WorkflowEvent>` return type for engine entrypoints.** Initially preferred, then revised. Rejected once `AgentInvoker` was locked as a Service Tag, because mirroring the same Service-Tag pattern for event emission (`WorkflowEventEmitter` with a Queue-backed Live layer) keeps the engine's return values clean and the DI shape symmetric. Streams force terminal-event gymnastics for returning the outputs map.

## Consequences

- **What becomes easier.** Adding a new phase later (for example, an agent-driven CR-title generator) is one new public function plus one more case in the event ADT. The architecture doc becomes true. The validator catches reference typos in change-request templates — today a silent failure that surfaces only after a successful run produces a malformed PR. Tests can assert on event sequences rather than poking at message-dispatch side effects.
- **What becomes harder.** The `workflow/` directory grows to ~18 files (still flat). Reasoning about the engine end-to-end now requires understanding both Service Tags and the per-run wiring in `run-lifecycle.ts` — the engine is no longer "just a few helpers". Anyone touching agent invocation now has a layer (literally) of indirection to navigate.
- **Follow-up work.** The per-module `makeWorkflowRuntime` and `WorkflowLayer` exports remain temporarily as migration scaffolding; they delete when `server.ts` boots a single app-wide `ManagedRuntime` merging every module's layer. The runtime-consolidation rule is now codified in `docs/migration-standards.md`.
- **What overturning this would require.** A future ADR would have to identify a concrete agent-invocation use case that does not flow through `workflow.yaml` (for example, a standalone diagnostic agent invoked outside any run). The current design accommodates this by extracting a smaller "agent invocation" module that `workflow/` depends on; absent that need, the consolidation here is the right boundary.
