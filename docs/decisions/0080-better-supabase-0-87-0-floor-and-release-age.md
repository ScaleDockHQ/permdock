# 0080. better-supabase 0.87.0 is the peer floor and catalog pin, and skips the release age

- Status: accepted
- Date: 2026-11-26
- Supersedes: [0079](./0079-better-supabase-0-85-0-floor-and-release-age.md)

## Context

better-supabase 0.87.0 reached npm at 21:42 UTC on 2026-11-25 (`pnpm view better-supabase time`). Its `AuthorizationPermissionFilter` is `{ keyArgument: number }`. Doctor BS430 accepts a call to a listed filter when that argument is a string literal, and it does not check a tenant argument. `permdock/better-supabase` fills `permissionFilters` from the one-argument active-tenant helpers, which 0.85.0 rejects as an unknown provider key.

It peers on `workflow >=5.8.0`, `eve >=1.5.0`, `ai >=7.0.181`, `hono >=4.13.21`, `svelte ^5.59.1` and `@orpc/server >=2.0.0-beta.53`. `workflow` stays 5.4.0: 5.7.1 fails `trustPolicy` for the reason in 0074, and this bump does not retry that pin. The other pins are the newest releases older than `minimumReleaseAge` that meet those floors (`pnpm view <name> time` on 2026-11-26): ai 7.0.181, eve 1.5.0, hono 4.13.22, svelte 5.59.1, `@orpc/*` 2.0.0-beta.53.

## Decision

- The peer floor is `>=0.87.0`, `better-supabase-floor` aliases 0.87.0 and the catalog pins 0.87.0. The catalog also pins ai 7.0.181, eve 1.5.0, hono 4.13.22, svelte 5.59.1 and `@orpc/*` 2.0.0-beta.53.
- `minimumReleaseAgeExclude` lists `better-supabase@0.87.0` only. `better-supabase@0.85.0` leaves the list. `minimumReleaseAge` stays at 1440 and `trustPolicy` is unchanged.
- `peerDependencyRules.allowedVersions` keeps `better-supabase>workflow` at 5.

## Consequences

Remove the better-supabase exclude from 21:43 UTC on 2026-11-26. Adopters on better-supabase older than 0.87.0 must upgrade; the changeset marks the floor as breaking.

An `ai` override of `catalog:` keeps one copy. `@ai-sdk/react` and `@ai-sdk/otel` depend on the `ai` they shipped with, and two copies give the chat example two incompatible `chat` types.

svelte 5.59.1's client compiler imports `svelte/internal/init-operations`, which reads `window`. The precompiled `permdock/svelte` entry imports that module only when `window` exists.

## Alternatives considered

- Wait for the 24-hour age: the pull request would sit until 21:43 UTC on 2026-11-26.
- Keep the 0.85.0 floor: `permissionFilters` is an unknown key there, so the provider cannot declare the active-tenant helpers.
