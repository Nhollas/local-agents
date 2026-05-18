# Slice 2 — One-walk validator across all 4 template surfaces

## What to build

Generalise `workflow/validator.ts` so a single walk catches reference typos across every template surface in `workflow.yaml`:

| Surface | Site | Scope available to references |
|---|---|---|
| Branch phase | `branch.agent.prompt` | `{}` (nothing — only `issue`/`branch` etc. via prompt scope) |
| Step phase (each) | `steps[N].prompt` | `steps[0..N-1].output` |
| Change-request phase | `change_request.title` and `change_request.body` | all steps' outputs |

Today the change-request templates are **unchecked** at load time — a typo there only surfaces after a successful run when the CR is rendered. This slice closes that gap.

Error-label discipline: every diagnostic includes the site identifier (`"branch.agent.prompt"`, the step's `name`, `"change_request.title"` / `"change_request.body"`). One generalised walk algorithm; only the scope set differs per site.

Errors raised are `WorkflowValidationError` from slice 1.

## Acceptance criteria

- [ ] Validator detects unknown `steps.<name>.output.<field>` references in `change_request.title` and `change_request.body` at load time and fails with `WorkflowValidationError`.
- [ ] Existing step-prompt validation behaviour preserved — references to a later step or an undeclared step name still fail.
- [ ] Diagnostic messages include the site label per the table above.
- [ ] Validator is one walk over the four surfaces, not three near-duplicates.
- [ ] `loadWorkflow` propagates the new validation failures via `WorkflowDefinitionError`.
- [ ] Tests cover all four surfaces — including a CR-template typo case.
- [ ] `pnpm typecheck && pnpm test` green.

## Blocked by

- Slice 1 (error taxonomy)
