# Testing

Tests live next to the code they cover, in `__tests__` folders inside each module. Everything runs under Vitest in a single Node process. There is one runner and one config; the layers differ in where they draw the boundary.

For the system under test, see [architecture.md](architecture.md). For coding standards, see [coding-standards.md](coding-standards.md).

## Layers

The suite follows a classicist (Detroit-school) testing style on top of the ports-and-adapters layout described in `architecture.md`. Three layers:

- **Unit.** Pure logic. No HTTP, database, or filesystem. One module under test, imports limited to other pure modules.
- **Adapter integration.** The real HTTP client and the real adapter, with [MSW](https://mswjs.io/) intercepting outbound traffic. One pair per external system. This is where wire-format details live — JQL escaping, clone URL formatting, change-request payloads.
- **Orchestrator integration.** The real orchestrator wired to stub `TrackerAdapter` and `CodeHostAdapter` implementations, a SQLite test database, the bounded runner, and a workspace under the OS temp directory. Scenarios are expressed against the orchestrator's behaviour: dispatch ordering, lifecycle pinning, recovery after restart, transition failures.

Each layer owns its assertions. HTTP details belong to the adapter layer; orchestration scenarios belong to the orchestrator layer. The orchestrator suite never observes HTTP, because the orchestrator itself never does.

## Test doubles

The orchestrator integration tests use stub adapters in `server/testing/support/` that implement the production `TrackerAdapter` and `CodeHostAdapter` interfaces. They record calls and let tests assert against the recording. They do not model issue-state machines or change-request lifecycles internally — the real adapters do, and the adapter integration tests cover that.

Because the stubs typecheck against the production interfaces, an interface change fails compilation before it fails a test.

`createTestOrchestrator` wires a real orchestrator against fresh stubs, a SQLite test database, a runner with a small concurrency pool, and a temp-directory workspace. It returns the stubs and the database, and cleans up on its own.

## Conventions

- Tests live next to the code they cover.
- Tests assert on observable behaviour through the public surface, not on internal calls or implementation details.
- No `vi.mock` or inline mocking of internal modules. Substitute at the port boundary via the existing stub adapters, or via constructor parameters.
- `pnpm test` runs everything. `pnpm test:coverage` is a diagnostic for spotting gaps, not a target.
