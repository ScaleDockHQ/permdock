# 0061. `definePermDock` for better-supabase owns `.next` and `.authorizer`

- Status: accepted
- Date: 2026-11-06

## Context

[0056](./0056-define-permdock-entry.md) put `definePermDock` in `permdock/app` and left `.next` and `.authorizer` off that object. A static import of `permdock/next` or `permdock/better-supabase` from `permdock/app` would load an optional peer in every app that imports the entry. A better-supabase app then built the authorizer, the `createNext` bag and the caches in three places, and the copies drifted.

## Decision

- `definePermDock` in `permdock/better-supabase` wraps the `permdock/app` definition. It adds `client`, `server`, `authorizer`, `next` and `getPermissions`. `fromClaims`, `fromApiKey`, `forClient` and `getPermDock` stay, and each instance is `PermDock` of the policy vocabulary.
- The version, instance and subject caches are created inside the call. Two definitions do not share them. A cache passed in the options is kept.
- `client()` calls the `client` option once and reuses the promise. It does not run at definition time.
- `.authorizer` and `.next` live on this definition. `.next` returns `{ authorization, authorizer, versions }` for better-supabase's `createNext`. `permdock/app` does not gain either member.
- This amends 0056. It does not replace [0060](./0060-no-recursive-scopes.md).

## Consequences

A better-supabase app imports `definePermDock` from `permdock/better-supabase`. An app that does not use better-supabase keeps importing it from `permdock/app`.

## Alternatives considered

- Add `.next` and `.authorizer` to `permdock/app` behind a dynamic import: every app would still carry the member, and a missing peer would fail at the call rather than at the import the app chose.
