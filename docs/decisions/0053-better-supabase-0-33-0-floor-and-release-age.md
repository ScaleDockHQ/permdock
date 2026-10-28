# 0053. better-supabase 0.33.0 is the peer floor and the catalog pin, and skips the one-day release age

- Status: accepted
- Date: 2026-10-28
- Supersedes: the floor, catalog pin, exclude and CI matrix of 0051

## Context

better-supabase 0.33.0 reached npm at 22:33 UTC on 2026-10-27. `pnpm view better-supabase@0.33.0 version` confirmed it at implementation time. The [upstream changelog](https://github.com/ScaleDockHQ/better-supabase/blob/main/CHANGELOG.md) was reviewed for 0.30 through 0.33:

- 0.32 renames the public auth names: `auth.organization` becomes `auth.tenant`, `requireOrganization` becomes `requireTenant`, `bsb.session()` becomes `bsb.claims()`, `getRequestSession` becomes `getClaims`, and `invalidateSession` and `forgetSession` become `evictSession`. `better-supabase codemod 0.32` applies them.
- 0.33 adds the slots an authorization library fills: the types-only `better-supabase/contract` entry, `blockTables(config)` in `better-supabase/sql`, `AuthorizationContext` with `intent`, `operation`, `requestId` and `approval`, `resource.source` and `resource.change`, `AuthorizerRuntime<V>` typed by the server's `versions`, and `tokenHook.truncatedClaim`.

None of these exist in 0.29, so supporting both would mean feature detection in the provider and the tests. The standard installs only versions older than `minimumReleaseAge` (1440 minutes in `pnpm-workspace.yaml`).

## Decision

- The peer floor is `>=0.33.0`, the catalog pins 0.33.0 and `better-supabase-floor` aliases 0.33.0. `ci.yml` runs the provider and its integration tests on the one entry `0.33.0`.
- `minimumReleaseAgeExclude` lists `better-supabase@0.33.0`, that version only. `minimumReleaseAge` stays at 1440 and `trustPolicy: no-downgrade` still checks the release. The 0.29.0 entry of 0051 is gone.
- `permdock/better-supabase` imports its slot types from `better-supabase/contract`, and reads `context.intent`, `context.approval`, `resource.source`, `resource.change` and `runtime.versions` without a fallback for older releases.
- `authorizationProvider` sets `tokenHook.truncatedClaim` to `permissions_truncated`, so better-supabase never reads PermDock's `memberships_truncated` budget marker as a marker for the `permissions` claim. PermDock's hook does not own `permissions`.

## Consequences

Remove the exclude from 22:34 UTC on 2026-10-28. Adopters on better-supabase 0.32 or older must upgrade, and run `better-supabase codemod 0.32` if they are on 0.31 or older, before installing the next `permdock` release.

## Alternatives considered

- Keep the 0.29 floor and feature-detect the 0.33 slots: every slot keeps two branches in the provider and the tests, and CI would test a version whose auth names the docs no longer use.
- Wait one day for the release age: CI would not test the version adopters can already install.
