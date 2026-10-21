# 0041. better-supabase 0.12.0 skips the one-day release age

- Status: accepted
- Date: 2026-10-21

## Context

better-supabase 0.12.0 reached npm at 22:21 UTC on 2026-10-20. The standard installs only versions older than `minimumReleaseAge` (1440 minutes in `pnpm-workspace.yaml`) and never bypasses it.

0.12.0 changes nothing that `permdock/better-supabase` imports or implements, and its SQL modules are the 0.11.0 ones. It changes one behaviour the example depends on: `auth.jwks: null` now verifies against no keys instead of fetching `env.jwksUrl`. The peer range `>=0.11.0` (decision 0040) already accepts 0.12.0, so adopters can install it today, before CI has tested it.

## Decision

The catalog pins 0.12.0. `minimumReleaseAgeExclude` lists `better-supabase@0.12.0`, that version only. `minimumReleaseAge` stays at 1440, and `trustPolicy: no-downgrade` still checks the release. The floor stays at 0.11.0, so the CI matrices in `ci.yml` and `database.yml` list `0.11.0` and `0.12.0`, and the committed SQL comes from 0.12.0.

## Consequences

The exclusion is unneeded from 22:22 UTC on 2026-10-21; remove the entry then, together with the 0.11.0 entry of 0040. Any other better-supabase version still waits one day.

## Alternatives considered

- Wait one day for the release age: CI would not test the version adopters can already install.
- Raise the floor to 0.12.0: nothing in `permdock/better-supabase` needs 0.12.0, and adopters on 0.11.0 would have to upgrade for no gain.
