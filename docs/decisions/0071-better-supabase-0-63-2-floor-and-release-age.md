# 0071. better-supabase 0.63.2 is the peer floor and the catalog pin, and skips the one-day release age

- Status: accepted
- Date: 2026-11-12
- Supersedes: the floor, catalog pin, exclude and CI matrix of 0067

## Context

better-supabase 0.63.2 reached npm at 13:48 UTC on 2026-11-12 and is `latest`. The [upstream changelog](https://github.com/ScaleDockHQ/better-supabase/blob/main/packages/better-supabase/CHANGELOG.md) was reviewed for 0.59 through 0.63.2. The releases PermDock builds on:

- 0.61.0 adds `AuthzSubjectSeed.tenant` and `Bootstrap.subjectTenant`: the tenant a bootstrap subject is restricted to by `subjectForTenant`, or `null` for the whole subject. An authorizer that seeds its cache from the subject must ignore a seed for another tenant.
- 0.61.0 limits an API key to the permissions its scopes map to, makes ownership transfer, organization deletion, impersonation, platform invitations and SSO management interactive-only, and ships `api/naming.json`. The `permissions` and `api-keys` modules change, so the example runs `better-supabase upgrade` and adds a migration.
- 0.62.0 makes `db.$decode(table).row()` and `.rows()` asynchronous. PermDock does not call them.
- 0.59.0 to 0.63.2 add and tune doctor rules BS219, BS386, BS634 and BS635. The example's doctor run reports no warnings.

## Decision

- The peer floor is `>=0.63.2`, `better-supabase-floor` aliases 0.63.2 and the catalog pins 0.63.2. `ci.yml` runs the provider and its integration tests on the one entry `0.63.2`.
- `minimumReleaseAgeExclude` lists `better-supabase@0.63.2`, that version only. `minimumReleaseAge` stays at 1440.
- `authorizer` passes the seed's `tenant` to the resolver as `subjectTenant`, and the resolver seeds `subjects` only when the subject covers the tenant being checked. `SupabaseAccessResult` and `PermDockForResult` gain an optional `subjectTenant`.

## Consequences

Remove the 0.63.2 exclude from 13:49 UTC on 2026-11-13. Adopters on better-supabase 0.62 or older must upgrade before installing the next permdock release, and the changeset marks the floor as breaking.

## Alternatives considered

- Keep the 0.58 floor and test 0.63 in a matrix: the seed's `tenant` field is absent on 0.58 to 0.60, so the provider would need its own wider seed type.
