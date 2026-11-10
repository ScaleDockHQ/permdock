# 0065. Release runs after CI, without a second verify

- Status: accepted
- Date: 2026-11-10

## Context

The standard's `release.yml` runs on `push` to `main` and calls `verify.yml` before Changesets, so the release commit is gated inside the release workflow. npm trusted publishing accepts a token from `push`, `release` or `workflow_dispatch`, and rejects one from `pull_request_target` or `issue_comment`. The publisher is the workflow filename.

On the push of `a4d6c53b7`, CI run 42527608931 and the Release run each ran `verify.yml`. The release copy took 11 runner-minutes (static 250s, test 304s, perf 116s) and started with CI, so neither run could read the cache the other was writing.

## Decision

`.github/workflows/release.yml` starts from `workflow_run` when the CI workflow completes on `main`. It does not call `verify.yml`. The job runs only when that CI run succeeded, its event was `push`, and its head repository is this one. The checkout is the default branch, the ref `workflow_run` trusts. The job publishes only when that commit is `workflow_run.head_sha`, so a newer push on `main` does not publish an older CI result. zizmor's `dangerous-triggers` audit flags every `workflow_run`; the trigger line ignores that one finding. `cache-mode` is `read` on the workflow and `none` on the job. The publish stays in `release.yml`, so the trusted publisher's workflow filename does not change.

## Consequences

- A push to `main` no longer spends those 11 runner-minutes on a second verify. The release waits for CI instead of running beside it.
- `workflow_run` reads this file from `main`, so the change takes effect on the merge.
- A publish from a `workflow_run` event is outside the events the standard lists. The OIDC subject still names `release.yml`. If npm rejects the token, the publish fails and nothing is published.

Revisit if npm rejects the token, or if a release commit needs a gate CI did not run.

## Alternatives considered

- Keep the second verify: measured at 11 runner-minutes per push, with no cache shared with the CI run beside it.
- Stay on `push` and drop the verify: Changesets can publish a commit CI has not finished.
