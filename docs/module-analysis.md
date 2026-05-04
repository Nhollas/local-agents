# Module Analysis — `server/`

This is a snapshot of how `server/` is structured, taken on 2026-05-03. It looks at two complementary views of the codebase:

1. **Static dependency graph**, which shows what each module imports (gathered via `madge`).
2. **Change coupling**, which shows which modules tend to move together in commits (computed across the last 55 commits via `git log`).

The static view answers whether the boundaries are drawn well. The change-coupling view checks whether those boundaries actually hold up once the code is being edited in practice. As the rest of this document shows, the static picture is fairly clean, and the more interesting signal sits in the change-coupling picture.

---

## TL;DR

- No circular dependencies were found. The static graph is layered cleanly, with types at the bottom and `server.ts` as the composition root, and there are no cycles across the 88 files that were analysed.
- The codebase has the shape of a layered monorepo rather than a tangled web. `types` sits as a pure leaf (15 fan-in, 0 fan-out), and `server.ts` sits as a pure root (0 fan-in, 15 fan-out).
- Three change-coupling pairs are worth a closer look. In each case the modules co-evolve far more often than the static graph would suggest:
  - `orchestrator ↔ workflow` (82%, 14 co-changes)
  - `code-hosts ↔ trackers` (86%, 6 co-changes)
  - `runner ↔ run-repository` (89%, 8 co-changes)
- The remaining high-coupling pairs, such as `db ↔ runner` at 100% or `config ↔ server` at 90%, are structurally expected, since schema and configuration touches naturally radiate outwards.

---

## Module inventory

| Module           | Files | Fan-in | Fan-out | Role                                                          |
| ---------------- | ----: | -----: | ------: | ------------------------------------------------------------- |
| `types`          |     3 |     15 |       0 | Shared brand types and exhaustiveness helpers; pure leaf      |
| `server.ts`      |     1 |      0 |      15 | Composition root that wires everything together               |
| `orchestrator`   |     9 |      1 |      11 | Application core: ticking, dispatch, run lifecycle            |
| `api`            |     4 |      1 |       7 | HTTP surface, SSE, problem-details                            |
| `trackers`       |     4 |      3 |       5 | Issue-tracker adapters (GitHub, Jira) plus decorator          |
| `code-hosts`     |     4 |      2 |       4 | Code-host adapters (GitHub, GitLab) plus decorator            |
| `workflow`       |     4 |      2 |       1 | Workflow loader, validator, prompt preprocessor               |
| `runner`         |     2 |      3 |       3 | Job queue and run execution                                   |
| `db`             |     3 |      4 |       1 | Schema, migration, drizzle setup                              |
| `run-repository` |     1 |      4 |       2 | Persistence access layer for runs                             |
| `*-client`       |     3 |    2-3 |       2 | HTTP clients for GitHub, GitLab, and Jira; consumed by adapters |
| `http-client`    |     1 |      3 |       0 | Shared HTTP primitive                                         |
| `config`         |     1 |      3 |       1 | YAML config loader and types                                  |
| `event-bus`      |     1 |      3 |       2 | In-process event bus                                          |
| `scope-resolver` |     1 |      2 |       1 | Repo and scope matching                                       |
| `logger`         |     1 |      3 |       1 | pino wrapper                                                  |
| `canonical-log`  |     1 |      4 |       0 | Structured log helpers                                        |

---

## Static layering

There are no cycles, and the modules stratify cleanly:

```
                            ┌──────────────────┐
                            │    server.ts     │  composition root
                            └────────┬─────────┘
                                     │
                ┌────────────────────┼─────────────────────┐
                │                    │                     │
          ┌─────▼─────┐       ┌──────▼───────┐       ┌─────▼─────┐
          │    api    │       │ orchestrator │       │ *-client  │
          └─────┬─────┘       └──────┬───────┘       └─────┬─────┘
                │                    │                     │
                │    ┌───────────────┼───────────┐         │
                │    │               │           │         │
                │  ┌─▼────┐    ┌─────▼────┐  ┌───▼─────┐   │
                │  │runner│    │ trackers │  │workflow │   │
                │  └─┬────┘    └─────┬────┘  └─────────┘   │
                │    │               │                     │
                │    │           ┌───▼──────┐              │
                │    │           │code-hosts│◄─────────────┘
                │    │           └───┬──────┘
                │    │               │
        ┌───────▼────▼───────────────▼─────────────────────┐
        │  run-repository · db · event-bus · config ·      │
        │  scope-resolver · logger · http-client           │
        └───────────────────────────┬──────────────────────┘
                                    │
                              ┌─────▼─────┐
                              │   types   │  pure leaf
                              └───────────┘
```

The top edges by weight (where the weight is the file count of imports) are:

| Edge                           | Files |
| ------------------------------ | ----: |
| `orchestrator → trackers`      |     6 |
| `orchestrator → workflow`      |     6 |
| `trackers → types`             |     6 |
| `code-hosts → types`           |     3 |
| `orchestrator → canonical-log` |     3 |
| `orchestrator → runner`        |     3 |
| `server → code-hosts`          |     3 |
| `server → trackers`            |     3 |

`orchestrator` is the only module with double-digit fan-out (11), which is appropriate given its role as the application core. Every other module sits in single digits.

---

## Change coupling

This view shows what changed together in the last 55 commits. The coupling percentage is computed as `co_changes / min(A_commits, B_commits)`.

| Pair                              | Co-changes | A churn | B churn | Coupling | Verdict                                                  |
| --------------------------------- | ---------: | ------: | ------: | -------: | -------------------------------------------------------- |
| `db ↔ runner`                     |          9 |       9 |      16 | **100%** | Structural; schema changes are run-shaped                |
| `config ↔ server`                 |          9 |      10 |      14 |  **90%** | Structural; the composition root reads configuration     |
| `orchestrator ↔ run-repository`   |          8 |      27 |       9 |  **89%** | Structural; orchestrator is run-repository's only consumer |
| `run-repository ↔ runner`         |          8 |       9 |      16 |  **89%** | ⚠ runner may be re-implementing run-repository concerns   |
| `code-hosts ↔ trackers`           |          6 |       7 |      15 |  **86%** | ⚠ shared concept that probably ought to be hoisted        |
| `orchestrator ↔ workflow`         |         14 |      27 |      17 |  **82%** | ⚠ workflow is not yet a stable abstraction                |
| `db ↔ orchestrator`               |          7 |       9 |      27 |     78% | Structural; schema shapes propagate to consumers          |
| `orchestrator ↔ runner`           |         12 |      27 |      16 |     75% | Structural; orchestrator dispatches via runner            |
| `orchestrator ↔ trackers`         |         11 |      27 |      15 |     73% | Structural; orchestrator consumes trackers                |
| `server ↔ trackers`               |         10 |      14 |      15 |     71% | Structural; this is wiring code                           |
| `config ↔ trackers`               |          7 |      10 |      15 |     70% | Recent: scope-based config touches both                   |
| `github-client ↔ server`          |          7 |      10 |      14 |     70% | Structural; this is wiring code                           |

The most-churned modules are `orchestrator` (27 commits), `workflow` (17), `runner` (16), and `trackers` (15). All four are expected, given that the recent repo-scoping work has been concentrated in that area.

### The three suspicious pairs

These are pairs where the static graph suggests the boundary is fine, but where the edits keep reaching across it anyway. Each one is worth a closer look.

**1. `orchestrator ↔ workflow` (82%, 14 co-changes)**

The orchestrator imports `workflow` types in 6 files, and the two modules co-changed in 14 of the last 55 commits. There are two plausible explanations: either workflow's public shape simply isn't stable yet, which is reasonable given the pre-launch reality, or the orchestrator is dipping into workflow internals it shouldn't see. It is worth checking which `workflow/*` exports the orchestrator actually imports. If it is just types and a `RepoWorkflow` factory, the situation is fine. If it is reaching into specific step implementations or rendering helpers, the abstraction is leaking.

**2. `code-hosts ↔ trackers` (86%, 6 co-changes)**

These are sibling adapter modules, and neither imports the other directly. They keep co-changing nonetheless, which suggests they share a domain concept that lives in both places, most likely repo identity, PR or issue cross-references, and label semantics. Each shared concept that lives in both modules is one more place where a future change has to be made twice. This pair is a candidate for hoisting into a small shared module.

**3. `run-repository ↔ runner` (89%, 8 co-changes)**

`runner` has a single file that imports `run-repository`, and the two changed together in 8 of the 9 commits where `run-repository` changed, which is surprisingly tight. One reading is benign: `runner` legitimately tracks every persistence-shape change because it writes runs to the repository. The other reading is that some persistence logic has spread into `runner` and ought to move back into `run-repository`. A short read of the two files side by side should settle which is happening.

The other high-coupling pairs, such as `db ↔ runner`, `config ↔ server`, and `orchestrator ↔ run-repository`, are structurally expected. Schema, composition, and consumer relationships will always co-change to some degree.

---

## Honest verdict

Overall the codebase has a coherent shape rather than a tangled one. The static structure is good: the layers are clean, there are no cycles, the fan-in and fan-out values are sensible, `types` sits as a pure leaf, and `server.ts` sits as a pure root. That puts it ahead of most codebases of this size.

The recent refactor pain is mostly explained by two large features, repo-scoping and retry removal, which deliberately reshaped the orchestrator, workflow, and tracker triangle. That kind of churn is expected work rather than evidence of a structural problem. The 20-file PRs reflect the cost of breaking changes that the user explicitly chose to make, rather than the cost of badly drawn module boundaries.

The three suspicious pairs above are worth investigating. None of them rises to the level of "the architecture is wrong". They sit closer to "small abstractions to extract or tighten when the area is next touched".

Concrete next steps if you want to act on this:

1. Read the `orchestrator/*.ts` imports of `workflow/*` and check whether they target stable surface or implementation peek-throughs.
2. Diff `code-hosts/github.ts` against `trackers/github.ts` (and the GitLab and Jira pairs) for shared concepts that ought to be hoisted into a tiny shared module.
3. Open `runner/runner.ts` next to `run-repository.ts` and ask whether persistence calls have leaked into the runner.

If all three come back clean, the conclusion is that nothing needs to change in the structure, and the recent pain was simply the cost of making breaking changes during the pre-launch period.
