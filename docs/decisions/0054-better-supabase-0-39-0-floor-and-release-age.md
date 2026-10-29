# 0054. better-supabase 0.39.0 is the peer floor and the catalog pin, and skips the one-day release age

- Status: accepted
- Date: 2026-10-29
- Supersedes: the floor, catalog pin, exclude and CI matrix of 0053

## Context

better-supabase 0.39.0 reached npm at 07:28 UTC on 2026-10-29. The [upstream changelog](https://github.com/ScaleDockHQ/better-supabase/blob/main/packages/better-supabase/CHANGELOG.md) was reviewed for 0.34 through 0.39. Peers and subpaths are unchanged from 0.33. The releases PermDock builds on:

- 0.35 adds `AuthorizationHooks.sessionTags(userId)`, `AuthzVersionCache.seed?(userId, version)`, `bsb.bootstrap()`, `bsb.getAccess()`, the 300-second `bsb.cached()` stale time, and the sessions block's `authzVersions` with `AUTHZ_TOPIC`, `AUTHZ_EVENT` and `authzUserTopic`.
- 0.35 adds tenant policies, `mode: "confirm" | "authorize"`, manager approvers and `approvalFingerprint` to the approvals block.
- 0.36 to 0.39 change blocks PermDock does not wrap.

permdock 0.17.0 is a breaking release built on these slots: the docs, the examples and the approvals bridges assume them. On 0.33 the provider tests fail where they read `AUTHZ_TOPIC` from `better-supabase/server`.

## Decision

- The peer floor is `>=0.39.0`, the catalog pins 0.39.0 and `better-supabase-floor` aliases 0.39.0. `ci.yml` runs the provider and its integration tests on the one entry `0.39.0`.
- `minimumReleaseAgeExclude` lists `better-supabase@0.39.0`, that version only. `minimumReleaseAge` stays at 1440. The 0.33.0 entry of 0053 is gone.

## Consequences

Remove the exclude from 07:29 UTC on 2026-10-30. Adopters on better-supabase 0.38 or older must upgrade before installing permdock 0.17.0.

## Alternatives considered

- Keep the 0.33 floor: the 0.35 slots stay optional, but CI tests a release whose sessions block, approvals block and cache names the docs no longer use, and each test that reads them needs a version guard.
- Wait one day for the release age: CI would not test the version adopters can already install.
