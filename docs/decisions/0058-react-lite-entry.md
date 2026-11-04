# 0058. `permdock/react/lite` is a client entry that evaluates nothing

- Status: accepted
- Date: 2026-11-04

## Context

A client that imports `permdock/react` ships the snapshot evaluator: `fromSnapshot`, the client store, the condition evaluator and the scope resolver. `tests/bundle` measures the typical import at 20,263 B gzip (`saas client react`). A navigation menu, a hidden button or a route gate asks only a type-level question ("may this user create a quote?"), which `permdock.grantedPermissions()` already answers on the server. No tree-shaking change reduces the evaluator, because the full client needs it for row-level checks.

`naming.mdc` allows an entry only for core, a feature contract, or an implementation named after the npm package whose hooks it maps. `permdock/react/lite` is none of them.

## Decision

- `permdock/react/lite` is a sibling of `permdock/next/client` and `permdock/supabase/client`: a client sub-entry of an existing adapter, not a new adapter.
- It exports `PermDockProvider`, `usePermission` and `Protected`, the names of `permdock/react`, with a smaller contract: the provider takes `granted`, the server's `grantedPermissions()` list; `usePermission(permission)` answers `{ allowed }`; `Protected` takes `permission`, `denied` and `children`.
- It matches by `key` (invariant 5), accepts only the list (a leaf survives RSC props, invariant 4) and denies without a provider or for a permission outside the list (invariant 1).
- There is no `data` parameter, so a row-level check does not type-check. A permission granted only through a condition, a relation or a closure is not in `grantedPermissions()` and is denied.
- It imports React and types only, so it pulls no core module. `tests/bundle` measures it at 282 B gzip (`react/lite PermDockProvider + usePermission + Protected`).
- The server stays the authority: the list is a rendering hint, and every action the UI offers is re-checked by `getPermission`, `requirePermission` or `protectAction`.

## Consequences

An app with only type-level UI checks drops about 20 KB gzip of client JavaScript. An app with row-level checks keeps `permdock/react`. Both providers can coexist in one tree only in separate subtrees: they use different contexts.

## Alternatives considered

- A `lite` option on `permdock/react`: the evaluator stays in the bundle.
- Send decision booleans keyed by string: strings as public keys (invariant 3).
- Split the evaluator out of `permdock/react`: row-level hooks would lose the synchronous answer from the snapshot.
