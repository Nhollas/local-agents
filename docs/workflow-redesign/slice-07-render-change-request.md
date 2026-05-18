# Slice 7 — Pure `renderChangeRequest` (delete `change-request-renderer.ts`)

## What to build

Third (and final) workflow phase converted. Pure function, no Effect, no Service Tags.

- `workflow/render-change-request.ts`:

```ts
renderChangeRequest: (
  template: ChangeRequestTemplate,
  scope: PromptScope,
  branch: string,
  outputs: Record<string, unknown>,
) => { title: string; body: string }
```

- Delete `server/orchestrator/change-request-renderer.ts`.
- `run-lifecycle.ts` calls the engine function directly when assembling the CR for `codeHost.createChangeRequest`.

The reference resolution rules in `title` / `body` are the same as `steps[N].prompt` — substitutions against `scope` (`issue.*`, `baseBranch`), `branch`, and `steps.<name>.output.<field>`. Validator (slice 2) ensures no typos reach here at load time.

## Acceptance criteria

- [ ] Pure synchronous function — no `Effect`, no async, no Service Tag dependencies.
- [ ] `{{ issue.key }}`, `{{ issue.title }}`, `{{ branch }}`, `{{ steps.<name>.output.<field> }}` all substituted in both `title` and `body`.
- [ ] `orchestrator/change-request-renderer.ts` deleted; `run-lifecycle.ts` calls the engine function directly.
- [ ] All semantic cases listed under "Slice 7" in `semantic-cases.md` covered by new tests.
- [ ] No `as` casts.
- [ ] `pnpm typecheck && pnpm test` green.

## Blocked by

- Slice 2 (validator generalised to cover CR templates — without it, typos still slip through at runtime here)
