# 0048. better-supabase 0.18.0 is the catalog pin and skips the one-day release age

- Status: accepted; the catalog pin is superseded by 0050
- Date: 2026-10-25
- Supersedes: the catalog pin and exclude of 0047

## Context

better-supabase 0.17.0 adds `ownTablePolicies` and `options.stamp`. 0.18.0 refuses `team_ids_of` for another signed-in user, lets a member hold several roles (`blocks.memberships.options.roles.many`, read by a provider through `memberships[].rolesTable`), and has doctor BS409 compare `tokenHook.activeOrganizationFrom` with `blocks.permissions.activeTenant`. `permdock/better-supabase` fills both new provider fields. The example's SQL is regenerated in the 0.18 shape, which older releases cannot load.

better-supabase 0.18.0 reached npm at 15:46 UTC on 2026-10-25, 36 minutes after 0.17.0. The standard installs only versions older than `minimumReleaseAge` (1440 minutes in `pnpm-workspace.yaml`).

## Decision

- The catalog pins 0.18.0, and `minimumReleaseAgeExclude` lists `better-supabase@0.18.0`, that version only. `minimumReleaseAge` stays at 1440 and `trustPolicy: no-downgrade` still checks the release. 0.17.0 is never pinned, and the 0.16.0 entry of 0047 is gone: the lockfile no longer resolves it.
- The peer floor stays `>=0.13.0`, and `better-supabase-floor` still aliases 0.13.0. `ci.yml` tests the provider and its integration tests on `0.13.0` and `0.18.0`.
- `database.yml` still runs the example stack on the catalog pin only, with no matrix.

## Consequences

Remove the exclude from 15:47 UTC on 2026-10-26. A 0.13 to 0.17 install ignores `rolesTable` and `activeOrganizationFrom`, which those releases' types do not declare.

## Alternatives considered

- Wait one day for the release age: CI would not test the version adopters can already install.
- Raise the peer floor to 0.18.0: a provider config without `rolesTable` still loads on 0.13, so the floor stays where `teamIdsOf` became valid.
