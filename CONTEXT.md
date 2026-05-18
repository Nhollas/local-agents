# Context

Project glossary. Pin canonical terms here when they get resolved in conversation. Implementation details belong elsewhere (`docs/architecture.md`, ADRs in `docs/adr/`, or the code itself) — this file is vocabulary, not specification.

## Workflow engine

The `server/workflow/` module. Owns everything to do with `workflow.yaml`: loading, parsing, validating, and executing each of its three phases against a real agent. The orchestrator composes the engine into a run lifecycle but does not itself invoke agents.

The engine is the only place that depends on the Claude Agent SDK at runtime.

## Phase

A first-class executable section of `workflow.yaml`. There are exactly three, all siblings:

- **branch phase** — `branch:` in the YAML. Resolves the branch name for a run, either by rendering a literal template or by running an agent against a fixed output schema.
- **step phase** — each entry in `steps:`. Renders a prompt, runs an agent, optionally captures structured output for downstream phases to reference.
- **change-request phase** — `change_request:` in the YAML. Pure template render that produces the title and body of the change request the orchestrator opens.

Branch and change_request are *not* "special cases of steps" or one-off helpers — they are sibling phases with the same first-class status. Treat them uniformly when reasoning about validation, template scope, and engine surface.

## Prompt scope

The set of values available when the engine renders a workflow template. Defined by the engine; never reaches up into tracker or code-host types. Each phase composes its prompt scope from what is known by the time that phase runs — for example, branch templates see only the issue (no branch resolved yet), step templates additionally see the resolved branch and any prior step outputs, change-request templates see all step outputs.

## Workflow event

A tagged value emitted by the engine as a phase progresses (turn started, assistant message produced, structured output decoded, phase failed, and so on). Consumers — the dashboard, the run repository, telemetry, the canonical log — react to these events without the engine knowing what those consumers do.

The orchestrator owns the consumer side; the engine owns the producer side. The set of event tags is the public contract between them.
