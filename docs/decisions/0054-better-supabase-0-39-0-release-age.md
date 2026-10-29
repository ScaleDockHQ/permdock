# 0054. better-supabase 0.39.0 is the catalog pin and skips the one-day release age

- Status: accepted
- Date: 2026-10-29
- Supersedes: the catalog pin, exclude and CI matrix of 0053; its floor stays

## Context

better-supabase 0.39.0 reached npm at 07:28 UTC on 2026-10-29. The [upstream changelog](https://github.com/ScaleDockHQ/better-supabase/blob/main/packages/better-supabase/CHANGELOG.md) was reviewed for 0.34 through 0.39. Peers and subpaths are unchanged from 0.33. The releases PermDock builds on:

- 0.35 adds `AuthorizationHooks.sessionTags(userId)`, `AuthzVersionCache.seed?(userId, version)`, `bsb.bootstrap()`, `bsb.getAccess()`, the 300-second `bsb.cached()` stale time, and the sessions block's `authzVersions` with `AUTHZ_TOPIC`, `AUTHZ_EVENT` and `authzUserTopic`.
- 0.35 adds tenant policies, `mode: "confirm" | "authorize"`, manager approvers and `approvalFingerprint` to the approvals block.
- 0.36 to 0.39 change blocks PermDock does not wrap.

Each of these is optional in the provider contract, so 0.33 adopters keep working: an older release never calls `sessionTags` or `seed`.

## Decision

- The catalog pins 0.39.0. The peer floor and `better-supabase-floor` stay at 0.33.0.
- `ci.yml` runs the provider and its integration tests on `0.33.0` and `0.39.0`.
- `minimumReleaseAgeExclude` lists `better-supabase@0.39.0`, that version only. `minimumReleaseAge` stays at 1440. The 0.33.0 entry of 0053 is gone.

## Consequences

Remove the exclude from 07:29 UTC on 2026-10-30.

## Alternatives considered

- Raise the floor to 0.35: every 0.35 slot PermDock fills is optional, so the floor would exclude adopters for no runtime gain.
- Wait one day for the release age: CI would not test the version adopters can already install.
