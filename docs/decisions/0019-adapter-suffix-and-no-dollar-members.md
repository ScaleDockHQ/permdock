# 0019. Adapter-first type names and no `$` members

- Status: accepted
- Date: 2026-10-03

## Context

The repo standard's naming rules (`architecture.md`, "Factories and types" and "Objects keyed by user data") ask for two things PermDock does differently.

- Every adapter factory returns `<Prefix><Thing>`, with one library prefix. PermDock has one factory name, `createPermDock`, in 23 entries. Each entry returns a different shape, so `PermDockHono`, `PermDockExpress` and so on would read as variants of one type.
- An object keyed by user data puts its own members behind `$` (`$key`), so a user key cannot collide with them. The permissions tree (`permissions.post.read`) is keyed by user data, and so is the policy's `resources` map.

## Decision

- Adapter types are `<Adapter>PermDock` and `<Adapter>PermDockOptions` (`HonoPermDock`, `SsfPermDockOptions`, `A2aPermDock`). The adapter comes first because it is what tells the types apart; the `PermDock` noun stays the one library prefix, at the end. Core keeps `PermDock` and `PermDockOptions`.
- No public object has `$` members. The permissions tree holds only resources and permission leaves. Its helpers are free functions (`isPermission`, `listPermissions`, `findPermission`) and symbols, not members, so a resource named `key` or `meta` cannot collide with anything. `$`-prefixed members stay on the reserved list on the Naming page.

## Consequences

- `docs:drift` checks names against `tests/bundle/src/exports.json` and the banned instance names, not against a `<Prefix><Thing>` pattern.
- A new adapter follows `<Adapter>PermDock`. If PermDock ever adds a member to a user-keyed object, this record is revisited, because the free-function rule would no longer hold.

## Alternatives considered

- `PermDock<Adapter>` (`PermDockHono`): reads as a variant of `PermDock` rather than a different shape.
- `$` members on the permissions tree: API surface that only the collision rule needs, when free functions avoid the collision.
