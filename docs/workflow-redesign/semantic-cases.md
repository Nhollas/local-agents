# Workflow redesign — semantic cases checklist

Behaviours harvested from the orchestrator tests we deleted up front (`step-runner.test.ts`, `branch-resolver.test.ts`, `change-request-renderer.test.ts`, `agent-logging.test.ts`). These are the **semantics that must survive** the rebuild — but covered by *fresh* tests at the new public boundaries (engine entrypoints + `WorkflowEvent` sequences), not by porting the old assertion shapes.

Each slice owns the cases listed under it. Slice authors: when you finish, every box below in your section should have at least one new test that asserts the behaviour from the consumer's perspective (event sequence, returned outputs map, error tag) — not from internals.

## Slice 5 — `resolveBranch`

Branch phase, via `runAgentTurn`.

- [ ] **Literal branch template** (`agent/issue-{{ issue.number }}`) renders without invoking the agent. No `runAgentTurn`, no `BranchAssistantMessage`, just `BranchResolved` with usage zeroed.
- [ ] **Dynamic branch form** invokes the agent with `outputSchema` and the prompt rendered against `PromptScope` (e.g. `{{ issue.key }}` substituted).
- [ ] Structured output **missing the `name` field** fails with `StructuredOutputDecodeError { context: "branch" }`.
- [ ] Agent stream ends **without a result message** fails with an `AgentTurnError`.
- [ ] Result subtype `error_max_structured_output_retries` fails with `AgentTurnError { subtype: "error_max_structured_output_retries" }`.
- [ ] Cost / token usage from the result message surfaces in `BranchResolved.usage` (per-model breakdown).

## Slice 6 — `runSteps`

Steps phase, via `runAgentTurn` looped.

- [ ] **Action step** (no `output_schema`) does not pass `outputSchema` to the invoker; any `structured_output` on the result message is ignored.
- [ ] **Output step** (with `output_schema`) passes the schema, decodes structured output, and includes it in the returned `outputs` map keyed by step name.
- [ ] `result.subtype === "error_max_structured_output_retries"` aborts the loop with `StructuredOutputDecodeError { context: "step" }`; subsequent steps are not invoked; `StepFailed` is emitted for the failing step.
- [ ] `{{ branch }}` substitutes the resolved branch name into a step prompt.
- [ ] `{{ steps.<name>.output.<field> }}` substitutes an earlier step's structured output into a later step's prompt (output-feeds-next-prompt).
- [ ] **Env** propagates from the per-run wiring into each `AgentInvokeOptions.env`.
- [ ] **`allowed_tools`** forwarded to the invoker when present; absent otherwise.
- [ ] **Per-step `model`** passed through unchanged.
- [ ] **Cost / token aggregation** across multiple models — every result message contributes to per-model `StepUsage`. Aggregation happens consumer-side (event-consumer) from `StepResult` events, not inside the engine.
- [ ] Usage is still emitted for the **failing step** before the loop aborts (so failure cost is not silently dropped).
- [ ] Event sequence per successful step: `StepStarted { name, index, total }` → `StepResult { stepName, structuredOutput?, sessionId, usage }` → `StepCompleted { stepName, index, durationMs }`.
- [ ] `resume_previous: true` threads the prior step's `sessionId` into the next `runAgentTurn` call.

## Slice 7 — `renderChangeRequest`

- [ ] Pure function. `{{ issue.key }}`, `{{ issue.title }}`, `{{ branch }}` substituted into both `title` and `body`.
- [ ] `{{ steps.<name>.output.<field> }}` references in CR templates resolved against the final `outputs` map. (New territory — validator catches typos at load time per slice 2.)

## Slice 8 — `event-consumer` fiber

The transcript / tool-use behaviour that was inside `agent-logging.ts` now lives consumer-side, fed by `*AssistantMessage` events that carry raw `AgentMessage` payloads.

- [ ] Text blocks → `agent:say` SSE event; empty/whitespace text skipped.
- [ ] `Read` tool → `tool:read` with **workdir-relative** path.
- [ ] `Edit` / `Write` / `MultiEdit` → `tool:edit`.
- [ ] `Grep` → `tool:grep` with pattern + workdir-relative path + `matches: 0` initial.
- [ ] `Bash` → `tool:bash` with `state: "running"`, `exitCode: null`, command with `/private` symlink prefix normalised relative to `cwd`.
- [ ] Unknown tools → `tool:other` with summary derived from a known input field (`query`, etc.).
- [ ] `Agent` tool summary uses `description`, not `prompt`.
- [ ] `Skill` tool summary uses `skill` name.
- [ ] `StructuredOutput` tool emits no transcript event.
- [ ] `tool_use_by_name` counter aggregated on the canonical log bag.
- [ ] Canonical-log bag receives: `steps_total`, `steps_completed`, `step_durations_ms`, `step_outputs_collected` (names only, not payloads), `total_cost_usd`, `total_input_tokens`, `total_output_tokens`, `models_used` per-model breakdown, `failed_step` on failure.
- [ ] `measure_diff` runs after `StepCompleted` for steps with `measure_diff: true` (consumer responsibility, uses `parse-shortstat.ts`).

## Out of scope — behaviour we are deliberately dropping

- The old `runWorkflowSteps({ ctx, runRepo, agent, workflow, issue, ... })` direct-call surface. Engine entrypoints now take `PromptScope` (not `Issue`) and consume `AgentInvoker` / `WorkflowEventEmitter` via Service Tags. Tests asserting on `agent.calls[i].prompt` etc. become tests asserting on emitted events + the outputs map.
- Tests whose only job was asserting log/warning emission (per project rule).
