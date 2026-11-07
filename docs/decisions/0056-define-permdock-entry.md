# 0056. `permdock/app` is a server-only entry, and `definePermDock` replaces `defineApp`

- Status: accepted
- Date: 2026-11-04

## Context

`defineApp` bound shared options to a policy. It lived in the root `permdock` entry, so a client bundle could import it, and it bound only what core and the adapters read through `withApp`. `permdockFor`, `authorizer`, `authorizationHooks` and `postgrestSources` never called `withApp`, so a better-supabase app repeated `memberships`, `versions`, `instances` and `subjects` in each of them and the copies drifted.

The consumer feedback asked for one definition that also builds instances: `getPermDock`, `fromClaims`, `fromApiKey`, `sources` and `evict`, plus `.next` and `.authorizer` members that return the adapter bound to the app.

## Decision

- `definePermDock(policy, options)` lives in the new `permdock/app` entry. The entry is server-only: it imports `subjectFromApiKey` from `server/kit.ts` and `mapClaimsToSubject` from `jwt`, and `tests/bundle` measures it.
- The `define*` prefix stays although the result is not a plain definition: it is a policy that carries the app definition and five non-enumerable members. Every adapter still accepts it where it accepts a policy.
- `defineApp` is removed from the root entry, with no alias. `permdock codemod 0.5` lists each import as a signature change.
- `permdockFor`, `authorizer`, `authorizationHooks`, `supportPolicy`, `subscriberPolicy` and `postgrestSources` read `memberships`, `instances`, `versions`, `subjects` and the other sources from the definition. Their own options win.
- `claims` and `credentials` in the definition are read by `fromClaims` and `fromApiKey` only. `withApp` leaves them out, because `authorizationHooks` has its own `claims` loader.
- No `.next` or `.authorizer` member. They would make `permdock/app` load `permdock/next` and `permdock/better-supabase`, both optional peers, in every app that imports the entry. Each is one call: `createPermDock(app)` and `authorizer({ policy: app })`.

## Consequences

An app that imported `defineApp` from `permdock` changes the import and the name. The `claimsFirst` wrapping that `permdockResolver` built per version cache moved to `core/version-sources.ts`, shared by `permdockFor` and `definePermDock().sources`.

## Amendment, 2026-11-05

`forClient(client)` joins the members. It binds `memberships`, `customRoles` and `subjects` from the `sources(client)` option for a client that exists only per request or lazily. The result is a definition like any other, so `createPermDock`, `authorizer` and `permdockFor` take it unchanged.

## Amendment, 2026-11-06

[0061](./0061-better-supabase-define-permdock.md) puts `definePermDock` for a better-supabase app in `permdock/better-supabase`. `.next` and `.authorizer` live on that definition. `permdock/app` still has neither, so the entry does not load the optional peers.

## Alternatives considered

- Keep `defineApp` and add `definePermDock` beside it: two ways to bind the same options.
- Keep the root export: a client entry could import `subjectFromApiKey` through it (invariant 8).
- Add the `.next` and `.authorizer` members: a static import of an optional peer in a core entry.
