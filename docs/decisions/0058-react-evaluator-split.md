# 0058. `permdock/react` loads its evaluator on demand

- Status: accepted
- Date: 2026-11-04

## Context

`permdock/react` shipped the snapshot evaluator (`fromSnapshot`, the condition evaluator, the scope resolver) in its entry chunk: 20,263 B gzip in `tests/bundle` (`saas client react`). Most client checks ask a type-level question ("may this user create a quote?") that the server can answer ahead of time. A separate lite entry would make every app choose.

## Decision

- The server writes `typeLevel` into the snapshot (`{ granted, approval?, endpoint? }`, lists of permission keys). It is computed by `typeLevelOf` with the rowless evaluator, so it matches what the client evaluator answers. It is omitted when any grant has `validity` or a membership has `expiresAt`, because the answer then depends on the clock. `simulate` drops it.
- `store.quick(permission)` answers from that table. `usePermission(permission)` and `<Protected permission>` use it and return `{ allowed, status, outcome }` without loading the evaluator.
- `usePermission(permission, data)`, `useDecision`, `useGate`, `usePermDock` and the function forms of `<Protected>` need a `Decision`. They suspend on `use(store.loading())` while `client/evaluator.ts` is fetched with a dynamic import. The entry chunk keeps a placeholder instance (`light-instance.ts`) that denies everything.
- `permdock/react-native` and the other UI adapters keep the eager evaluator.
- `snapshot` v1 gains an optional field; older clients ignore it and older snapshots have no table, so `quick` returns `undefined` and the hooks load the evaluator.

## Deviation: module-level state

`evaluator-lazy.ts` holds a write-once cache for the import promise and the loaded builder. Invariant 7 forbids module-level mutable state in core; this is client code, the value is the module itself (identical for every caller), and a per-store promise would fetch the chunk once per provider.

## Consequences

Measured with `tests/bundle` (gzip): the initial download of `saas client react` drops from 20,263 B to 14,637 B; the total including the lazy chunk is 21,636 B. Server entries that call `snapshot()` grow by 0.1 to 1.8 KB because `snapshotOf` now evaluates once per permission. A hook that needs a `Decision` suspends on first use, and `renderToString` cannot render it: use streaming or prerender. `usePermission(permission)` no longer returns `decision`; this is breaking.

## Alternatives considered

- a separate lite entry: the user chooses, and a wrong choice denies silently.
- Compute decisions on the server per rendered component: needs the row data on the server.
