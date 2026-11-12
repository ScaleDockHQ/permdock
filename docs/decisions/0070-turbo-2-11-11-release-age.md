# 0070. turbo 2.11.11 skips the one-day release age

- Status: accepted
- Date: 2026-11-12

## Context

turbo 2.11.11 reached npm at 18:30 UTC on 2026-11-11 and its six `@turbo/*` platform packages between 18:29 and 18:38 UTC. The standard installs only versions older than `minimumReleaseAge` (1440 minutes in `pnpm-workspace.yaml`). The maintainer asked to adopt the release on 2026-11-12 at 14:58 UTC, about 20 hours after publication.

## Decision

- The catalog pins `turbo` and `eslint-plugin-turbo` to 2.11.11.
- `minimumReleaseAgeExclude` lists those two and the six `@turbo/*` platform packages at 2.11.11, those versions only. `minimumReleaseAge` stays at 1440 and `trustPolicy: no-downgrade` still checks the release.

## Consequences

Remove the eight entries after 18:38 UTC on 2026-11-12; `minimumReleaseAgeExcludePrune` also drops them once the lockfile no longer resolves them.
