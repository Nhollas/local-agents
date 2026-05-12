---
name: tdd
description: Test-driven development with a red-green-refactor loop. Drive one behaviour at a time as a vertical slice — write a failing test, write the minimal code to pass it, repeat. Survives refactors because tests verify behaviour through public interfaces, not implementation details. Use when the issue calls for test-first work, when fixing a bug that has a sensible test seam, or when the user asks to "TDD this" / "red-green-refactor" / "test-first".
---

# Test-Driven Development

## Philosophy

**Core principle:** tests verify behaviour through public interfaces, not implementation details. Code can change entirely; tests shouldn't.

**Good tests** are integration-style: they exercise real code paths through public APIs. They describe _what_ the system does, not _how_ it does it. A good test reads like a specification — "user can checkout with a valid cart" tells you exactly what capability exists. These tests survive refactors because they don't care about internal structure.

**Bad tests** are coupled to implementation. They mock internal collaborators, test private methods, or verify through external means (querying a database directly instead of using the interface). The warning sign: your test breaks when you refactor, but behaviour hasn't changed. If you rename an internal function and tests fail, those tests were testing implementation, not behaviour.

## Anti-pattern: horizontal slicing

**DO NOT write all tests first, then all implementation.** This is "horizontal slicing" — treating RED as "write all tests" and GREEN as "write all code."

This produces **crap tests**:

- Tests written in bulk test _imagined_ behaviour, not _actual_ behaviour.
- You end up testing the _shape_ of things (data structures, function signatures) rather than user-facing behaviour.
- Tests become insensitive to real changes — they pass when behaviour breaks, fail when behaviour is fine.
- You outrun your headlights, committing to test structure before understanding the implementation.

**Correct approach:** vertical slices via tracer bullets. One test → one implementation → repeat. Each test responds to what you learned from the previous cycle. Because you just wrote the code, you know exactly what behaviour matters and how to verify it.

- Wrong: `test1, test2, …, testN` then `impl1, impl2, …, implN`.
- Right: `test1 → impl1 → test2 → impl2 → …`

## Workflow

### 1. Plan the behaviours

Before writing any code:

- List the behaviours to test, ranked by importance. Critical paths and complex logic first.
- Identify the public interface you're testing against. Avoid private functions and internal collaborators.
- Sketch the test seam — where the test naturally lives. If there is no clean seam, that itself is the finding (note it and either restructure or implement without TDD).

You cannot test everything. Focus testing effort on critical paths, not every possible edge case.

### 2. Tracer bullet

Write ONE test that confirms ONE thing about the system:

```
RED:   Write test for first behaviour → test fails
GREEN: Write minimal code to pass → test passes
```

This is the tracer bullet — proves the path works end-to-end.

### 3. Incremental loop

For each remaining behaviour:

```
RED:   Write next test → fails
GREEN: Minimal code to pass → passes
```

Rules:

- One test at a time.
- Only enough code to pass the current test.
- Don't anticipate future tests.
- Keep tests focused on observable behaviour.

### 4. Refactor

After all tests pass, look for refactor candidates:

- Extract duplication.
- Deepen modules — move complexity behind simple interfaces.
- Consider what new code reveals about existing code.
- Run tests after each refactor step.

**Never refactor while RED.** Get to GREEN first.

## Checklist per cycle

```
[ ] Test describes behaviour, not implementation
[ ] Test uses public interface only
[ ] Test would survive an internal refactor
[ ] Code is minimal for this test
[ ] No speculative features added
```

## Bug-fix variant

When TDD is being used to lock down a bug fix:

1. Turn the minimised repro into a failing test at the correct seam.
2. Watch it fail (confirms the test would catch a regression).
3. Apply the fix.
4. Watch it pass.
5. Re-run the original repro to confirm the fix actually addresses the user-visible symptom, not a nearby one.

If there is no correct seam for the regression test — the bug needs multiple callers, or the unit test can't replicate the chain that triggered it — say so explicitly and implement the fix without a forced shallow test. A misleading regression test is worse than no test.
