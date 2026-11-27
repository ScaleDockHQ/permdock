# 0083. better-supabase 0.91.0 is the catalog pin and skips the release age; the floor stays 0.87.0

- Status: accepted
- Date: 2026-11-27
- Amends: [0080](./0080-better-supabase-0-87-0-floor-and-release-age.md)

## Context

better-supabase 0.91.0 reached npm at 18:45 UTC on 2026-11-27 (`pnpm view better-supabase time`). It measures the twice-encoded session cookie in doctor BS405, returns a sessions bootstrap's permissions only for a call that names a tenant (`permissions: "tenant" | "all" | false` per entry), drops the server-only options from `createProxy`, and warms PostgREST with `OPTIONS` beside the first request. PermDock's docs and doctor PD110 describe the same cookie limit and the one-tenant bootstrap, and the examples and tests should run against the release that has them.

Its peer ranges are the same as 0.87.0's, so no other catalog pin moves.

## Decision

- The catalog pins better-supabase 0.91.0.
- The peer floor stays `>=0.87.0` and `better-supabase-floor` keeps aliasing 0.87.0: nothing in `permdock/better-supabase` needs an API newer than 0.87.0, and the floor CI matrix keeps proving that.
- `minimumReleaseAgeExclude` lists `better-supabase@0.91.0` instead of `better-supabase@0.87.0`, whose date has passed. `minimumReleaseAge` stays at 1440 and `trustPolicy` is unchanged.

## Consequences

Remove the better-supabase exclude from 18:46 UTC on 2026-11-28.

## Alternatives considered

- Wait for the 24-hour age: the PermDock release with the cookie and one-tenant seed fixes would wait a day for a pin it does not depend on at runtime.
- Raise the floor to 0.91.0: adopters on 0.87 to 0.90 would have to upgrade for no API PermDock uses.
