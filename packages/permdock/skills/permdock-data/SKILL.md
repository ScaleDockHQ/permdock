---
name: permdock-data
description: Enforces PermDock permissions in database queries and Postgres row-level security. Use when listing rows with permdock.where() and filter(), compiling conditions with toWhere from permdock/drizzle, permdock/prisma or permdock/kysely, guarding Convex functions with permdock/convex, generating or verifying RLS with permdock rls generate, verify or migrate, modelling folders, sub-teams or reporting lines with parent and relation() through a RelationSource, loadRelations or whoCan, or proving query and database parity with ormParity and rlsParity. Also for doctor PD027, PD028, PD031 and PD032.
license: MIT
metadata:
  author: ScaleDockHQ
  homepage: https://permdock.com/docs/adapters/rls
  repository: https://github.com/ScaleDockHQ/permdock
---

# PermDock data

The same portable conditions decide `can()` in memory, narrow list queries through `where()`, and compile to Postgres RLS. Keep them portable and prove the three agree ([conditions](https://permdock.com/docs/concepts/conditions), [RLS](https://permdock.com/docs/adapters/rls)). Set up the policy and factory first with the `permdock-wire` skill (`npx skills add ScaleDockHQ/PermDock --skill permdock-wire`); named scopes and memberships come from the `permdock-tenancy` skill.

## Inputs (find out, or ask before starting)

- The ORM or query layer: Drizzle, Prisma, Kysely, Convex, or raw SQL.
- Whether Postgres RLS enforces access as well (clients reading tables directly, a data API), and whether the app's SQL or PermDock's policy is the authority.
- Whether existing policies call hand-written helpers.
- Object hierarchies: nested folders, sub-teams, reporting lines, account delegates, rows that must not inherit.
- A test database for parity runs (a container or a branch database).

## Invariants

1. Portable first. Write `where` conditions with the portable operators; a closure is for checks they cannot express, and it is filtered in memory, never in SQL or RLS.
2. A list query uses `where()` before the query and `filter()` after it. One row is loaded and checked with `assert` or the adapter's `protect`.
3. Generated RLS never emits `service_role`, and a request runs as `authenticated` or `anon`.
4. RLS cannot see request `context`. A condition the database must enforce compares a server-set `principal.claims.*` value, never `user_metadata`.
5. Graph grants walk at most 32 hops (16 by default) and deny with `relation-unavailable` when the relation source is missing or unloaded.

## Workflow

1. **Narrow list queries.** Compile `permdock.where(permission)` with the ORM's `toWhere`, then run `filter` and `pick` on the rows. -> [references/queries-and-rls.md](references/queries-and-rls.md)
   ✓ A user with no grant gets an empty list, and the query compiles without `non-portable-condition`.
2. **Model hierarchies, when the product has them.** Give the resource a `parent`, declare the relations principals hold, add `restricted` where rows must not inherit, and grant with `relation(resource, name, { through: 'parent' })`. Pass a `RelationSource` as `relations` and call `loadRelations` before `can` / `filter` when it is async. Use `whoCan` for share dialogs. -> [references/relationships.md](references/relationships.md)
   ✓ `permdock doctor --only graph` is clean, and a viewer of a parent folder can read a child document.
3. **Generate or adopt RLS.** Run `permdock rls generate` from the policy, or keep SQL as the authority with `sqlFunction` twins and `rls.functions`, or move hand-written helpers with `permdock rls migrate`. -> [references/queries-and-rls.md](references/queries-and-rls.md#generate-and-verify-rls)
   ✓ `permdock rls generate --check` passes in CI.
4. **Verify against a real database.** Run `permdock rls verify --db $DATABASE_URL` with fixtures, `--tree` for graph grants, and `--introspect` against a deployed database.
   ✓ Every verify run exits `0`.
5. **Prove parity in tests.** Add `ormParity(policy, scenarios, { run, id })` for each list endpoint and `rlsParity(policy, options)` for RLS tables, from `permdock/testing` ([testing adapter](https://permdock.com/docs/adapters/testing)). Run `testRelationSource` on a custom `RelationSource`.
   ✓ The query and the database return exactly the rows `filter()` keeps.

## Verify before done

- [ ] No closure only compares fields a portable operator covers (`eq`, `in`, `memberOf`, `sqlFunction`, …); rewrite those as JSON conditions.
- [ ] An owner-equals-principal `where` on a resource with a matching relation uses `relation()` instead.
- [ ] No `opaque` RLS grant wraps a named helper; use `sqlFunction` with a twin and map it in `rls.functions`.
- [ ] No condition the database must enforce reads `context.*` (PD027); on Supabase, `supabase.hook.attrs` lists only server-owned values (PD028).
- [ ] Graph declarations are walked by a grant (PD031) and nameable in SQL (PD032).
- [ ] Every list endpoint has an `ormParity` run, every RLS table an `rlsParity` or `rls verify --db` run, and a custom `RelationSource` passes `testRelationSource`.

## Reference index

- [references/queries-and-rls.md](references/queries-and-rls.md): `toWhere` per ORM, `checkRow`, `withSubject`, Convex, `rls generate` / `import` / `verify` / `migrate` flags and config, field views, SQL as the authority.
- [references/relationships.md](references/relationships.md): `parent`, relation kinds, `restricted`, `links`, `relation(..., { through })`, `RelationSource`, `loadRelations`, `whoCan`, the closure table and `--tree`.
- Docs: [conditions](https://permdock.com/docs/concepts/conditions), [relationships](https://permdock.com/docs/concepts/relationships), [RLS adapter](https://permdock.com/docs/adapters/rls), [`permdock rls`](https://permdock.com/docs/cli/rls), [Postgres RLS](https://permdock.com/docs/standards/postgres-rls).
