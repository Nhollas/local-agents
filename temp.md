Coverage Summary (core/ only)

┌──────────────────────────────┬───────┬────────┬───────┬────────────────────┐
│ Module │ Stmts │ Branch │ Lines │ Gaps │
├──────────────────────────────┼───────┼────────┼───────┼────────────────────┤
│ event-bus.ts │ 100% │ 100% │ 100% │ — │
├──────────────────────────────┼───────┼────────┼───────┼────────────────────┤
│ github-client.ts │ 100% │ 100% │ 100% │ — │
├──────────────────────────────┼───────┼────────┼───────┼────────────────────┤
│ logger.ts │ 100% │ 100% │ 100% │ — │
├──────────────────────────────┼───────┼────────┼───────┼────────────────────┤
│ api/api.ts │ 100% │ 100% │ 100% │ — │
├──────────────────────────────┼───────┼────────┼───────┼────────────────────┤
│ code-hosts/github.ts │ 100% │ 75% │ 100% │ branch at L23 │
├──────────────────────────────┼───────┼────────┼───────┼────────────────────┤
│ db/schema.ts │ 67% │ 100% │ 67% │ L35 │
├──────────────────────────────┼───────┼────────┼───────┼────────────────────┤
│ orchestrator/orchestrator.ts │ 92% │ 86% │ 94% │ L222, 329, 408-422 │
├──────────────────────────────┼───────┼────────┼───────┼────────────────────┤
│ orchestrator/workspace.ts │ 71% │ 0% │ 71% │ L33-38 │
├──────────────────────────────┼───────┼────────┼───────┼────────────────────┤
│ runner/queue.ts │ 96% │ 93% │ 100% │ — │
├──────────────────────────────┼───────┼────────┼───────┼────────────────────┤
│ runner/runner.ts │ 98% │ 82% │ 100% │ — │
├──────────────────────────────┼───────┼────────┼───────┼────────────────────┤
│ trackers/decorator.ts │ 83% │ 100% │ 83% │ L28-32 │
├──────────────────────────────┼───────┼────────┼───────┼────────────────────┤
│ trackers/github.ts │ 94% │ 60% │ 100% │ branches L47-55 │
├──────────────────────────────┼───────┼────────┼───────┼────────────────────┤
│ workflow/workflow-cache.ts │ 82% │ 100% │ 81% │ L57-66 │
├──────────────────────────────┼───────┼────────┼───────┼────────────────────┤
│ workflow/workflow.ts │ 100% │ 100% │ 100% │ — │
└──────────────────────────────┴───────┴────────┴───────┴────────────────────┘

Overall core/: ~92% lines, ~82% branches. No test for server.ts directly, but all
its components are tested individually.

Biggest coverage gaps

1. workspace.ts (71% stmts, 0% branches) — the cleanupWorkspace error path (L33-38)
   is untested
2. db/schema.ts (67%) — some schema exports unused in tests
3. orchestrator.ts L408-422 — likely a less-exercised code path (probably the
   polling start()/stop() lifecycle)

Pattern Consistency Audit

What's done well (consistent everywhere):

- Vitest with describe/it/expect — uniform across all 10 test files
- Clear naming: _.test.ts for unit, _.integration.test.ts for integration
- Vitest config separates unit vs integration projects with different setupFiles
- Shared test helpers in tests/support/ (fixtures, MSW, test-db, test-config,
  test-workspace)
- Factory pattern: createTestDb(), createTestConfig(), createTestWorkflow(),
  createGitHubIssue()
- Integration tests spin up real in-memory SQLite — no DB mocking
- MSW for HTTP layer — no vi.mock() of fetch
- beforeEach creates fresh state; async disposal cleans up workspaces

Inconsistencies worth addressing:

Issue: DB seeding helpers are duplicated per test file
Impact: Each integration test re-defines seedRun(), seedEvent(), seedFailedRun()
locally
Examples: api.integration.test.ts vs orchestrator.retry.integration.test.ts
────────────────────────────────────────
Issue: MSW handler setup varies
Impact: Some tests use the shared githubHandlers() helper, others wire
http.get()/http.post() inline
Examples: Orchestrator tests use helper; others do it manually
────────────────────────────────────────
Issue: Local query helpers not shared
Impact: Functions like getRun(), getEvents() are reinvented per file
Examples: Could live in tests/support/

These are the three areas where tests diverge from what could be a single shared
convention. The seeding duplication is the most impactful — it means if the schema
changes, you'd need to update seed functions in multiple files.

Is vitest coverage "foolproof"?

No — V8 coverage measures executed lines/branches, not correctness. A line that
runs without assertions still counts as "covered." The real signal is whether tests
assert meaningful behavior, which yours generally do well (checking DB state, HTTP
interactions, label swaps, etc.). The branch coverage gaps (82% overall) are the
more honest metric — those show code paths that genuinely aren't exercised.

Want me to tackle any of these gaps — consolidating the seed helpers, improving
coverage on workspace.ts, or something else?
