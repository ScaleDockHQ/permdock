# 0047. better-supabase 0.16.0 is the catalog pin and skips the one-day release age

- Status: accepted; the catalog pin and exclude are superseded by 0048
- Date: 2026-10-25
- Supersedes: the catalog pin and exclude of 0046

## Context

better-supabase 0.16.0 adds a Realtime relay, a session watch for apps that keep the session out of the browser, resumable upload signing and `checkAll` rate limiting. It changes no name the `permdock/better-supabase` entry implements. The example's config and SQL stay in the 0.15 shape, which a 0.13 release cannot load.

better-supabase 0.16.0 reached npm at 10:39 UTC on 2026-10-25. The standard installs only versions older than `minimumReleaseAge` (1440 minutes in `pnpm-workspace.yaml`).

## Decision

- The catalog pins 0.16.0, and `minimumReleaseAgeExclude` lists `better-supabase@0.16.0`, that version only. `minimumReleaseAge` stays at 1440 and `trustPolicy: no-downgrade` still checks the release. The 0.15.1 entry of 0046 is gone: the lockfile no longer resolves it.
- The peer floor stays `>=0.13.0`, and `better-supabase-floor` still aliases 0.13.0. `ci.yml` tests the provider and its integration tests on `0.13.0` and `0.16.0`.
- `database.yml` still runs the example stack on the catalog pin only, with no matrix.

## Consequences

Remove the exclude from 10:40 UTC on 2026-10-26. The example stack stays on the pin; the floor keeps its provider, type and integration coverage in `ci.yml` and `tests/better-supabase/peer-floor.test.ts`.

## Alternatives considered

- Wait one day for the release age: CI would not test the version adopters can already install.
- Raise the peer floor to 0.16.0: nothing in this release rejects a 0.13 provider config, so the floor stays where `teamIdsOf` became valid.
