# 0067. better-supabase 0.58.0 is the peer floor, 0.58.1 the catalog pin, and both skip the one-day release age

- Status: accepted
- Date: 2026-11-11
- Supersedes: the floor, catalog pin, exclude and CI matrix of 0059

## Context

better-supabase 0.58.0 reached npm at 08:48 UTC on 2026-11-11 and 0.58.1 at 11:36 UTC the same day; `latest` is 0.58.1. The [upstream changelog](https://github.com/ScaleDockHQ/better-supabase/blob/main/packages/better-supabase/CHANGELOG.md) was reviewed for 0.54 through 0.58.1. The releases PermDock builds on:

- 0.58 adds fourteen optional fields to `AuthorizationProvider`: `functions.subjectForTenant`, `bootstrapPermissions`, `approverFor`, `managedUsers` and `canIn`, `memberships[].userKey`, `suspension.userKey`, `permissions[].levels`, `tokenHook.teamIdsTruncatedClaim`, `personas: "roles"` with `fixtureRoles`, and `wildcards`. `canApprove` and `approvals.distinctApprover` are accepted and ignored.
- 0.58 adds the `consumed` approval status and the `former_permission_key` error code, renames the exported `*Args` and `*Settings` types to `*Options`, and drops the `./codemods/*.json` export.
- 0.58.1 passes `{tenant}` to `managedUsers` and adds `teamIdsTruncatedClaim` to the bootstrap.

On 0.57 or older, the 0.58 provider fields do not exist on the contract type, so `authorizationProvider` needed its own wider `PermDockAuthorizationProvider` type to fill them.

## Decision

- The peer floor is `>=0.58.0` and `better-supabase-floor` aliases 0.58.0. The catalog pins 0.58.1. `ci.yml` runs the provider and its integration tests on `0.58.0` and `0.58.1`.
- `minimumReleaseAgeExclude` lists `better-supabase@0.58.0` and `better-supabase@0.58.1`, those versions only. `minimumReleaseAge` stays at 1440.
- `authorizationProvider` returns better-supabase's `AuthorizationProvider` type, and `PermDockAuthorizationProvider` is removed.

## Consequences

Remove the 0.58.0 exclude from 08:49 UTC and the 0.58.1 exclude from 11:37 UTC on 2026-11-12. Adopters on better-supabase 0.57 or older must upgrade before installing the next permdock release, and the changeset marks the floor as breaking.

## Alternatives considered

- Keep the 0.53 floor and test 0.58 in a matrix: the 0.58 fields would need the wider PermDock type again, and the floor's type would reject them.
- Pin 0.58.0 only: 0.58.1 fixes the `{tenant}` argument on `managedUsers`, which the provider fills.
