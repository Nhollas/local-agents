# Testing

Canonical rules for tests in this repo.

Goal: assert observable behaviour at the right layer; let interface changes fail compilation before they fail a test.

---

## Structure

- **Colocate.** Tests sit next to the code they cover (`foo.ts` + `foo.test.ts`). Shared fixtures, factories, and adapter stubs live in `server/test-support/`.
- **Substitute at the port.** Replace external collaborators via the existing stub adapters or constructor parameters. Never use `vi.mock`.
- **Tests first, setup last.** Constants, default options, and factory functions go at the bottom of the file. The test blocks are the main content and should be the first thing a reader sees after the imports.

## Layers

Each layer owns its assertions and never reaches into another layer's concerns.

- **Unit.** Pure logic. No HTTP, database, or filesystem. One module under test, imports limited to other pure modules.
- **Adapter integration.** The real HTTP client and the real adapter, with MSW intercepting outbound traffic. Wire-format details live here — JQL escaping, clone URL formatting, change-request payloads.
- **Orchestrator integration.** The real orchestrator wired to stub `TrackerAdapter` and `CodeHostAdapter` implementations, a SQLite test database, the bounded runner, and a workspace under the OS temp directory. Scenarios cover dispatch ordering, lifecycle pinning, recovery after restart, and transition failures. Never observes HTTP.

## Test doubles

Orchestrator integration tests use stub adapters in `server/test-support/` that implement the production interfaces. They record calls and let tests assert against the recording. They do not model issue-state machines or change-request lifecycles internally — the real adapters do, and the adapter integration tests cover that.

`createTestOrchestrator` wires a real orchestrator against fresh stubs, a SQLite test database, a runner with a small concurrency pool, and a temp-directory workspace. It returns the stubs and the database, and cleans up on its own.

## Decision rule

For any assertion: which layer owns this concern? If a test could live at multiple layers, push it as low as it'll go.
