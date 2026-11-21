# 0074. better-supabase 0.81.0 is the peer floor and catalog pin; it and the packages it peers on skip the release age

- Status: accepted
- Date: 2026-11-21
- Amends: 0071 (the floor), 0073 (the eve pin and the `better-supabase>eve` rule)

## Context

better-supabase 0.81.0 reached npm at 16:38 UTC on 2026-11-21. It exports `strictestApproval` from `better-supabase/eve`, which `permdock/eve`'s `approvalFor` pairs with, and it types `functions.roleIn`. It peers on `eve >=1.3.0`, `ai >=7.0.179`, `@ai-sdk/react >=4.0.183`, `workflow >=5.7.1`, `@orpc/server >=2.0.0-beta.50` and newer releases of the framework packages the repository pins.

eve 1.3.0, ai 7.0.179, `@ai-sdk/react` 4.0.183, `@ai-sdk/otel` 1.0.179 and `@ai-sdk/gateway` 4.0.152 were published between 23:19 and 23:28 UTC on 2026-11-20. `workflow` 5.7.1 fails `trustPolicy: no-downgrade` for the reason in 0073, and `solid-js` 1.9.20 fails it too.

## Decision

- The `peers` floor is `better-supabase >=0.81.0`, `better-supabase-floor` aliases 0.81.0 and the catalog pins 0.81.0. The floor stays open, with no upper bound.
- The catalog pins eve 1.3.0, ai 7.0.179, `@ai-sdk/react` 4.0.183, `@ai-sdk/otel` 1.0.179, `@orpc/*` 2.0.0-beta.52 and the framework packages 0.81.0 peers on (vue, hono, astro, elysia, fastify, `@sveltejs/kit`, `@solidjs/start`, `@tanstack/react-start`, `@nestjs/*`, `@supabase/supabase-js`, `@supabase/postgrest-typegen`, `temporal-polyfill`). `solid-js` pins 1.9.19.
- `minimumReleaseAgeExclude` lists `better-supabase@0.81.0`, `eve@1.3.0`, `ai@7.0.179`, `@ai-sdk/gateway@4.0.152`, `@ai-sdk/otel@1.0.179` and `@ai-sdk/react@4.0.183`, those versions only. `eve@1.2.0` and `better-supabase@0.63.2` leave the list. `minimumReleaseAge` stays at 1440 and `trustPolicy` is unchanged.
- `workflow` stays 5.4.0 and no `trustPolicyExclude` entry is added. `peerDependencyRules.allowedVersions` lets `better-supabase>workflow` resolve to 5 and `eve>solid-js` to 1; the repository's Solid adapters run Solid 1.

## Consequences

Remove the `@ai-sdk/*`, `ai` and `eve` excludes from 23:30 UTC on 2026-11-21 and the better-supabase exclude from 16:40 UTC on 2026-11-22. Retry `workflow` after 2026-12-13 23:55 UTC and then drop both `allowedVersions` rules. Adopters on better-supabase older than 0.81.0 must upgrade; the changeset marks the floor as breaking.

## Alternatives considered

- Keep the 0.63.2 floor: `permdock/eve` could not be tested against `strictestApproval`.
- Wait for the 24-hour age: the pull request would sit until 16:40 UTC on 2026-11-22.
