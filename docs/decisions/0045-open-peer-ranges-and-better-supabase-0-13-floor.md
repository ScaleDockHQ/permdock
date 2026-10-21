# 0045. Peer ranges are open floors; better-supabase 0.13.0 is the floor and skips the one-day release age

- Status: accepted
- Date: 2026-10-21
- Supersedes: 0043, and the floor and exclude parts of 0040 and 0041

## Context

Decision 0043 capped the `better-supabase` peer range below the minor after the catalog pin (`>=0.11.0 <0.13.0`). Every better-supabase minor then needed a PermDock release before an adopter could install it without a peer warning, and `strictPeerDependencies` turned that warning into a failed install. `jose` (`^6`) and `react` (`^19`) carried the same cap through a caret.

better-supabase 0.13.0 reached npm at 12:40 UTC on 2026-10-21. It adds an optional `authorization.functions.teamIdsOf` template, which `authorizationProvider` now fills for a `team` scope. 0.11.0 and 0.12.0 validate `authorization.functions` with a strict object, so a provider config that sets `teamIdsOf` fails to load on them. The standard installs only versions older than `minimumReleaseAge` (1440 minutes in `pnpm-workspace.yaml`).

## Decision

- Every entry in the `peers` catalog is a floor: `>=<lowest tested version>`, or floors joined by `||`. None has an upper bound, `^` or `~`. `tests/package/peers.test.ts` fails on any other range, and every `permdock` peer comes from that catalog.
- The `better-supabase` floor is 0.13.0, the first version that accepts `teamIdsOf`. `better-supabase-floor` aliases it, and the CI matrices in `ci.yml` and `database.yml` hold the one entry `0.13.0`.
- The catalog pins 0.13.0, and `minimumReleaseAgeExclude` lists `better-supabase@0.13.0`, that version only. `minimumReleaseAge` stays at 1440 and `trustPolicy: no-downgrade` still checks the release. The 0.11.0 and 0.12.0 entries of 0040 and 0041 are gone.

## Consequences

A peer release that breaks `permdock` is found by `better-supabase-latest.yml` and Dependabot, and fixed in a PermDock release; adopters are never blocked from installing a newer peer. Remove the exclude from 12:41 UTC on 2026-10-22. Adopters on better-supabase 0.11 or 0.12 must upgrade to use the next `permdock` release.

## Alternatives considered

- Keep the 0043 bound: each better-supabase minor would block adopters until a PermDock release, which is what this decision removes.
- Emit `teamIdsOf` only behind an opt-in and keep the 0.11.0 floor: adopters with a team scope would still need 0.13, and the provider would carry a version switch.
- Wait one day for the release age: CI would not test the version adopters can already install.
