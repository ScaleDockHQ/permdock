# 0051. better-supabase 0.29.0 is the peer floor and the catalog pin, and skips the one-day release age

- Status: accepted; superseded by 0053
- Date: 2026-10-26
- Supersedes: the floor of 0045, and the catalog pin, exclude and CI matrix of 0050

## Context

better-supabase 0.29.0 reached npm at 13:36 UTC on 2026-10-26. Since 0.28 the config has no `tables` key and `records` is renamed to `subjects`: tables are SQL files under `supabase/schemas` with `@bsb` tags, and every command refuses the old keys. `permdock/better-supabase` reads neither key, and the example's config uses neither.

Between the 0.13 floor of 0045 and 0.29, `permdock/better-supabase` carried code for releases adopters no longer need: a local stand-in for `AuthorizerRuntime`, both `bs_permission_cap` and `bsb_permission_cap` on an automation run, the flat `subjectType` and `subjectId` share-link row, and test-side feature detection for `renderModules`, `subscribeAuthzVersions` and `forgetSession`. 0.29 declares `@supabase/pg-delta >=1.0.0-alpha.60` as an optional peer, above the `1.0.0-alpha.59` pin `tests/integration` used. The standard installs only versions older than `minimumReleaseAge` (1440 minutes in `pnpm-workspace.yaml`).

## Decision

- The peer floor is `>=0.29.0`, the catalog pins 0.29.0 and `better-supabase-floor` aliases 0.29.0. `ci.yml` runs the provider and its integration tests on the one entry `0.29.0`; the next pin adds its own entry after the floor.
- `minimumReleaseAgeExclude` lists `better-supabase@0.29.0`, that version only. `minimumReleaseAge` stays at 1440 and `trustPolicy: no-downgrade` still checks the release. The 0.25.0 entry of 0050 is gone: the lockfile no longer resolves it.
- `@supabase/pg-delta` moves to `1.0.0-alpha.60`, which is past the release age.
- `permdock/better-supabase` drops the compatibility code above. `ShareLinkRow` takes only `subject: { type, id }`, and `authorizationHooks` writes only `bsb_permission_cap`; better-supabase 0.29 still reads `bs_permission_cap` from older tokens.
- `database.yml` runs the example stack on the catalog pin only.

## Consequences

Remove the exclude from 13:37 UTC on 2026-10-27. Adopters on better-supabase 0.28 or older must upgrade, and run `better-supabase migrate schema-first` if their config has `tables` or `records`, before installing the next `permdock` release.

## Alternatives considered

- Keep the 0.13 floor: every release since 0.13 keeps its own branch in the provider and the tests, and CI would test three versions no adopter starts on.
- Raise the floor to 0.25.0: it still carries the `tables` and `records` config that 0.29 refuses, so the example and the docs would describe a shape the newest release rejects.
- Wait one day for the release age: CI would not test the version adopters can already install.
