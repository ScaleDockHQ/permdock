# 0075. better-supabase 0.84.0 is the catalog pin and skips the release age; the peer floor stays 0.81.0

- Status: accepted
- Date: 2026-11-23
- Amends: 0074 (the catalog pin and its release-age entries)

## Context

better-supabase 0.84.0 reached npm at 16:56 UTC on 2026-11-23; 0.83.0 was never published. It carries the breaking config changes of the [0.82 to 0.83 guide](https://bettersupabase.com/docs/migration/0.82-to-0.83): `blocks` is a list, and `@supabase/pg-delta` and `@supabase/pg-topo` become its own exact-pinned dependencies. Its conformance kit requires `{tenant}` in `functions.approverFor`, and its SQL reads an `approverFor` template only when it names `{id}`, `{requester}` or `{tenant}`. Its doctor wants Supabase CLI 3.2.0.

`src/better-supabase` needs no export that 0.81.0 lacks.

## Decision

- The catalog pins better-supabase 0.84.0, `@supabase/pg-delta` 1.0.0-alpha.61 (the version 0.84.0 pins) and Supabase CLI 3.2.0. The peer floor stays `>=0.81.0` and `better-supabase-floor` stays 0.81.0.
- `minimumReleaseAgeExclude` lists `better-supabase@0.84.0` only. The 0.81.0, eve, ai and `@ai-sdk/*` entries of 0074 leave the list. `minimumReleaseAge` stays at 1440 and `trustPolicy` is unchanged.
- `authorizationProvider` no longer sets `functions.approverFor`. better-supabase reads it as the users who may decide a request, and `permdock_approver_for_ids()` returns the caller and the users the caller covers for, so filling `{tenant}` would let every caller decide every request.
- The example ignores better-supabase doctor BS721, BS722 and BS723 on `permdock/helpers.sql`: pg-topo 1.0.0-alpha.8 reads a `%type` column reference as a type and takes overloads for one function.

## Consequences

Remove the better-supabase exclude from 16:57 UTC on 2026-11-24. Drop the BS721 to BS723 ignores when pg-topo tells overloads apart. Raise the floor only when `src/better-supabase` imports a name 0.81.0 does not export.

## Alternatives considered

- Wait for the 24-hour age: the pull request would sit until 16:57 UTC on 2026-11-24.
- Raise the floor to 0.84.0: adopters on 0.81 would have to migrate their config for no PermDock feature.
- Add `{tenant}` to `permdock_approver_for_ids`: the set still answers "whom the caller acts for", which is the wrong question.
