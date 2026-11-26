# 0079. better-supabase 0.85.0 is the peer floor and catalog pin, and skips the release age

- Status: superseded by [0080](./0080-better-supabase-0-87-0-floor-and-release-age.md)
- Date: 2026-11-24
- Supersedes: [0075](./0075-better-supabase-0-84-0-pin-and-release-age.md) and [0076](./0076-better-supabase-main-tarball.md)

## Context

better-supabase 0.85.0 reached npm at 16:23 UTC on 2026-11-24 (`pnpm view better-supabase time`). It is the first release with the names `src/better-supabase` imports since 0.32: `ShareKeyHook`, `AuthorizationTableShare`, `AuthorizationEnforcement` and `VersionStoreEntry`. Until then the catalog installed a tarball packed from a pinned `main` commit (0076). It pins `@supabase/pg-delta` 1.0.0-alpha.61, `@supabase/pg-topo` 1.0.0-alpha.8 and `oxc-parser` 0.159.0, the versions the catalog already holds. `better-supabase upgrade --check` reports the example's and the provider-only fixture's SQL modules current.

## Decision

- The peer floor is `>=0.85.0`, `better-supabase-floor` aliases 0.85.0 and the catalog pins 0.85.0.
- `minimumReleaseAgeExclude` lists `better-supabase@0.85.0` only. `minimumReleaseAge` stays at 1440 and `trustPolicy` is unchanged.
- `scripts/better-supabase-checkout.ts`, its `.github/actions/setup` step, the `vercel.json` install steps, the `.better-supabase/` ignore entry and `peerDependencyRules.allowAny` for `better-supabase` are gone.
- `better-supabase doctor` runs without `--ignore BS607` in the example and the provider-only integration test: the floor alias and the installed copy are the same version.

## Consequences

Remove the better-supabase exclude from 16:24 UTC on 2026-11-25. Drop the example's BS721 and BS722 ignores when supabase/pg-toolbelt#609 and #610 are fixed.

## Alternatives considered

- Wait for the 24-hour age: the tarball, its checkout script and the `allowAny` entry stay one more day.
- Keep the 0.81.0 floor: `src/better-supabase` imports names 0.81.0 does not export.
