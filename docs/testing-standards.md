# Testing

Canonical rules for tests in this repo.

## Sections

- [Vitest](#vitest)

---

## Vitest

Goal: assert observable behaviour at the right layer; let interface changes fail compilation before they fail a test.

For the system under test, see [architecture.md](architecture.md). For coding standards, see [coding-standards.md](coding-standards.md).

### Always

- **Colocate.** Tests sit next to the code they cover (`foo.ts` + `foo.test.ts`). Shared fixtures, factories, and adapter stubs live in `server/test-support/`.
- **One runner.** Everything runs under Vitest in a single Node process. `pnpm test` runs the lot.
- **Assert on behaviour.** Target the public surface of the module under test, not internal calls or implementation details.
- **Substitute at the port.** Replace external collaborators via the existing stub adapters or constructor parameters.

### Layers

The suite follows a classicist (Detroit-school) style on top of the ports-and-adapters layout in `architecture.md`. Each layer owns its assertions and never reaches into another layer's concerns — HTTP details belong to the adapter layer; orchestration scenarios belong to the orchestrator layer.

- **Unit.** Pure logic. No HTTP, database, or filesystem. One module under test, imports limited to other pure modules.
- **Adapter integration.** The real HTTP client and the real adapter, with [MSW](https://mswjs.io/) intercepting outbound traffic. One pair per external system. Wire-format details live here — JQL escaping, clone URL formatting, change-request payloads.
- **Orchestrator integration.** The real orchestrator wired to stub `TrackerAdapter` and `CodeHostAdapter` implementations, a SQLite test database, the bounded runner, and a workspace under the OS temp directory. Scenarios cover dispatch ordering, lifecycle pinning, recovery after restart, and transition failures. The orchestrator suite never observes HTTP, because the orchestrator itself never does.

### Test doubles

Orchestrator integration tests use stub adapters in `server/test-support/` that implement the production `TrackerAdapter` and `CodeHostAdapter` interfaces. They record calls and let tests assert against the recording. They do not model issue-state machines or change-request lifecycles internally — the real adapters do, and the adapter integration tests cover that. Because the stubs typecheck against the production interfaces, an interface change fails compilation before it fails a test.

`createTestOrchestrator` wires a real orchestrator against fresh stubs, a SQLite test database, a runner with a small concurrency pool, and a temp-directory workspace. It returns the stubs and the database, and cleans up on its own.

### Use sparingly

- **`vi.mock` and inline mocking of internal modules.** Never. Substitute at the port boundary or via constructor parameters.
- **`pnpm test:coverage`.** A diagnostic for spotting gaps you care about, not a target to hit.

### Decision rule

For any assertion: which layer owns this concern? HTTP details → adapter layer. Orchestration scenarios → orchestrator layer. Pure logic → unit. If a test could plausibly live at multiple layers, push it as low as it'll go.
