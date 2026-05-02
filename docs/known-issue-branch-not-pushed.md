# Known issue: branch is not pushed before the change request is opened

## Summary

When a run completes successfully, the orchestrator asks the code host to open a change request (GitHub PR / GitLab MR) whose source branch only exists locally inside the workspace. The remote rejects the call because the branch was never pushed, leaving the run in `awaiting_review` with a warning and no MR to review.

Observed against GitLab as:

```
pr_create_failed: <repo>
on_complete_failed: GitLab API POST /projects/<repo>/merge_requests
  failed (400): {"message":{"source_branch":["does not exist"]}}
```

## Why it happens

[ADR 0001](./adr/0001-phase-outputs-and-fixed-lifecycle.md) lists the orchestrator's fixed lifecycle pins as: branch creation → push → change-request open → tracker transition. The implementation has the first, third, and fourth pins but is missing the second one. There is no `git push` step anywhere between the agent's commits and the change-request call, so the remote never sees the branch.

## Impact

- Every successful run that targets a code host with this gap fails to produce a reviewable change request.
- The local commits stay inside the workspace and are deleted when the workspace is cleaned up at the end of the run, so the agent's work is lost rather than just delayed.
- The tracker still transitions the issue to `awaiting_review`, which misrepresents the state — there is nothing to review.

## Scope

- Affects the GitLab code host adapter today; the same lifecycle gap will affect any future code host whose `createChangeRequest` is a remote API call rather than a local `gh`/`glab`-style command that pushes implicitly.
- Not a workflow-engine bug: the workflow steps run correctly and produce the expected commits.

## What a fix should do

1. Restore the missing lifecycle pin: push the run's branch to the remote after the workflow steps complete and before `createChangeRequest` is called.
2. Decide a retry policy for the push. Re-runs of the same issue use the same branch name, so the choice is between overwriting the remote branch (matches the project's pre-launch "drop old rows, rename freely" stance) or failing fast and requiring a fresh branch name per attempt.
3. Surface push failures the same way other lifecycle failures are surfaced today (canonical-log warning, run still recorded), so a transient remote outage does not silently lose the agent's work.

A proper fix is tracked separately; this document exists so the gap is visible until then.
