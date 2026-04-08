# GitLab Repository Configuration

Project-level settings to apply when hosting this repository on GitLab. Settings are grouped by priority rather than UI location, so you can work through them in order.

Where a setting requires a paid tier, the minimum tier is noted in parentheses.

## Protected Branches

`Settings > Repository > Branch rules`

Configure these for the `main` branch:

| Setting                          | Value          | Why                                               |
| -------------------------------- | -------------- | ------------------------------------------------- |
| Allowed to push and merge        | No one         | All changes go through merge requests             |
| Allowed to merge                 | Maintainers    | Prevents merging without appropriate review        |
| Allow force push                 | Off            | Protects commit history                            |
| Require code owner approval      | On (Premium)   | Domain experts must sign off on changes they own   |

## Merge Request Settings

`Settings > Merge requests`

### Merge Method

Use **fast-forward merge**. This requires the source branch to be rebased onto the target before merging and places commits directly on `main` with no merge commit. Combined with required squash (below), every MR becomes exactly one commit on `main`, giving you a fully linear history that is easy to read and revert from.

### Squash Commits

Set to **Require**. Every merge request becomes a single commit on `main`. This keeps the history clean and makes reverts straightforward. Individual commit history is still visible on the merge request itself.

With squash enabled, configure the squash commit message template:

```
%{title} (%{reference})

%{description}
```

This produces commits like `feat(server): add webhook support (!42)` followed by the MR description body.

### Merge Checks

| Setting                           | Value | Why                                                      |
| --------------------------------- | ----- | -------------------------------------------------------- |
| Pipelines must succeed            | On    | Broken code cannot reach main                            |
| Skipped pipelines are successful  | Off   | Prevents `[skip ci]` from bypassing quality gates        |
| All threads must be resolved      | On    | Forces explicit resolution of review feedback            |

### Merge Options

| Setting                               | Value          | Why                                                     |
| ------------------------------------- | -------------- | ------------------------------------------------------- |
| Enable merged results pipelines       | On (Premium)   | CI tests the result of merging, not just the branch     |
| Enable merge trains                   | On (Premium)   | Queues MRs so they are tested against each other        |
| Delete source branch on merge         | On             | Keeps the branch list clean                             |
| Automatically resolve threads         | Off            | Reviewers should resolve their own threads explicitly   |

Merged results pipelines are particularly valuable. Without them, two MRs can each pass CI independently but break `main` when merged together. Merge trains take this further by testing each queued MR against the expected state of `main` after all preceding MRs have merged.

### Approval Rules (Premium)

`Settings > Merge requests > Merge request approvals`

Create an approval rule requiring at least **1 approval** (or 2 if your team size supports it). Then configure approval settings:

| Setting                                            | Value | Why                                                       |
| -------------------------------------------------- | ----- | --------------------------------------------------------- |
| Prevent approval by merge request author           | On    | No self-approving                                         |
| Prevent approvals by users who add commits         | On    | Committers should not approve their own changes           |
| Prevent editing approval rules in merge requests   | On    | Project rules cannot be weakened on individual MRs        |
| Remove all approvals when commits are added        | On    | New commits invalidate previous approvals                 |

If you have a `CODEOWNERS` file, enable the **Coverage-Check** rule as well. This requires approval when an MR would decrease test coverage.

## Push Rules (Premium)

`Settings > Repository > Push rules`

| Setting                        | Value                  | Why                                                    |
| ------------------------------ | ---------------------- | ------------------------------------------------------ |
| Prevent pushing secret files   | On                     | Blocks accidental commits of keys, certs, credentials  |
| Maximum file size (MB)         | 10                     | Prevents large binaries from bloating the repository   |
| Reject unverified users        | On                     | Commits must come from verified GitLab accounts        |
| Do not allow tag removal       | On                     | Protects release tags from deletion                    |

If you use conventional commits, add a commit message regex to enforce them:

```
^(feat|fix|chore|docs|refactor|test|ci)(\(.+\))?: .+
```

This only applies to direct pushes. Squash commit messages are controlled by the merge request template above, so the two work together.

## CI/CD Settings

`Settings > CI/CD > General pipelines`

| Setting                              | Value      | Why                                             |
| ------------------------------------ | ---------- | ----------------------------------------------- |
| Auto-cancel redundant pipelines      | On         | Saves CI minutes when branches are pushed to    |
| Prevent outdated deployment jobs     | On         | Older deploys cannot overwrite newer ones        |
| Git strategy                         | git fetch  | Faster than clone, reuses the working directory  |
| Git shallow clone depth              | 20         | Fetches only recent history, speeds up checkout  |
| Timeout                              | 15 minutes | Fail fast on stuck jobs rather than burning time |

## Protected Tags

`Settings > Repository > Protected tags`

Protect the pattern `v*` and restrict creation to **Maintainers**. Combined with the "do not allow tag removal" push rule, this ensures release tags are created and managed only by maintainers.

## Secret Push Protection (Ultimate)

`Secure > Security configuration > Secret push protection`

Enable this. It scans commits during the pre-receive hook and blocks pushes that contain detected secrets such as API keys and tokens. Developers can bypass it in emergencies with `git push -o secret_push_protection.skip_all`, which is audit-logged.

## Settings You Can Skip

A few settings that appear in guides but are not worth configuring for most teams:

- **Reject unsigned commits** adds friction without proportional benefit unless you have a specific compliance requirement for commit signing.
- **Branch name regex** in push rules is less useful when all changes go through merge requests, since the branch is deleted after merge anyway.
- **Compliance frameworks** are worth exploring if you operate across many projects in a group, but are overhead for a single repository.
