# 0027. Dependabot waits 7 days

- Status: accepted
- Date: 2026-10-16

## Context

The standard sets `cooldown.default-days: 2` in `.github/dependabot.yml`. `permdock` is a published security library, and a compromised release of one of its build or test dependencies reaches every consumer through the next publish. Most malicious npm releases are found and unpublished within days.

## Decision

Both ecosystems in `.github/dependabot.yml` set `cooldown.default-days: 7`. `minimumReleaseAge` in `pnpm-workspace.yaml` stays at one day, so a maintainer can still adopt a release earlier by hand.

## Consequences

Dependabot PRs trail upstream releases by a week. A security fix that cannot wait is bumped by hand.

## Alternatives considered

- 2 days: shorter than the window in which most compromised releases are caught.
