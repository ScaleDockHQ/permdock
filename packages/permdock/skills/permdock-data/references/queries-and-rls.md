# Queries and generated RLS

Owning pages: [protected queries](https://permdock.dev/docs/concepts/policies#protected-queries), [RLS adapter](https://permdock.dev/docs/adapters/rls), [`permdock rls`](https://permdock.dev/docs/cli/rls), and the ORM pages [Drizzle](https://permdock.dev/docs/adapters/drizzle), [Prisma](https://permdock.dev/docs/adapters/prisma), [Kysely](https://permdock.dev/docs/adapters/kysely), [Convex](https://permdock.dev/docs/adapters/convex).

## List queries

```ts
import { toWhere } from "permdock/drizzle"; // or permdock/prisma, permdock/kysely

export async function listPosts(permdock: PermDock) {
  const read = permissions.post.read;
  const rows = await db
    .select()
    .from(posts)
    .where(toWhere(permdock.where(read), posts));
  return permdock.filter(read, rows).map((row) => permdock.pick(read, row));
}
```

- `permdock.where(permission)` narrows the query before it runs. It leaves out closure grants and marks the result `partial`; `filter` then drops what a closure refuses, and `pick` redacts fields.
- When nothing is granted, `toWhere` returns a constant false expression (no rows). A closure grant cannot compile: `toWhere` throws `PermDockValidationError`.
- `toWhere(condition, table, { columns })` maps schema fields to differently named columns. Graph grants need `{ relations: { closure: 'permdock.permdock_closure' } }`, otherwise a `related` node throws `non-portable-condition`.
- `checkRow` (Drizzle) answers one row as `{ found: false }` or `{ found: true, granted }`, so a handler can tell `404` from `403` with one query.
- Prisma also exports `permdockExtension`. Drizzle, Prisma and Kysely export `withSubject`, which runs a transaction as the subject (`set local role` plus claims) so RLS sees it; its `dialect` must match `rls generate`.
- Convex: `createPermDock` from `permdock/convex` returns `withPermDock` and `snapshotQuery`. Identity comes from `ctx` only; function arguments never influence the subject.

## Generate and verify RLS

```bash
pnpm exec permdock rls generate --target sql --dialect supabase --out migrations/rls.sql
pnpm exec permdock rls generate --target drizzle --dialect supabase
pnpm exec permdock rls import --sql migrations/rls.sql --out src/permissions.generated.ts
pnpm exec permdock rls verify --fixtures rls.fixtures.json
pnpm exec permdock rls verify --db $DATABASE_URL --fixtures rls.fixtures.json
pnpm exec permdock rls verify --introspect --db $DATABASE_URL
```

- Generated policies call `permdock_has('<key>')` and one `permitted_<scope>_ids('<key>')` per declared scope, which Postgres runs once per statement. Hand-written policies that only need membership (an organization switcher) call `member_<scope>_ids()` instead of inventing a permission key. Set `--tenant-type` (or `rls.tenantType`, `rls.scopeTypes`) to the scope columns' types.
- `--authorize database` (default) reads the membership tables per statement; map each under `rls.memberships.scopes.<scope>` with `columns` for its id and its ancestors', and `via` so roles with `for` apply. `--authorize jwt` reads token claims and stays stale until the token refreshes; keep the token lifetime at 3600 seconds or less (PD019).
- `--policy-per-role` keeps one policy per role for review. `--custom-roles` (or `rls.customRoles: true`) resolves tenant-defined roles inside the `permdock_ceiling` view.
- `--force` (or `rls.force: true`) only when the app connects as the table owner. Create views over RLS tables `with (security_invoker = true)` (PD022).
- When read grants set `fields` and clients read tables directly, add `--fields views --revoke-columns`: clients read `<table>_visible`, whose restricted columns are null unless a grant covers them. PD030 names columns still readable.
- `rls.suspension` drops suspended users' roles and memberships of suspended scope instances, live in both modes.
- Never emit `service_role`. Fixtures may carry `memberships`, `tenant` and `customRoles`.

## SQL as the authority

When the database already holds the rules, skip `generate`. Map each helper in `rls.functions`, write `sqlFunction` twins in the policy, and fail CI on `rls verify --db`. `--inline-functions` inlines the twin for targets that cannot call a SQL function.

When hand-written policies call the app's own helpers (`org_ids_with_permission`, `has_org_permission`), map each under `rls.migrate.helpers` with its `form` (`ids`, `row`, `scoped`, `global`, `membership`) and the legacy keys under `rls.migrate.keys` or `prefixes`. Run `permdock rls migrate`, read the skipped calls, and apply with `--write`. Generate with `--helpers-only` while the policies stay hand-written. A `row-conditions` skip means that table's policy should be generated, not migrated.

## Attributes RLS cannot see

A grant condition on `context.*` cannot be enforced by the database (PD027). Compare with a server-set `principal.claims.*` claim instead, never one from `user_metadata`. On Supabase, `supabase.hook.attrs` lists only server-owned columns or `app_metadata.<key>` entries clients cannot update (PD028). The hook, declarative schemas (`--split`) and `fromTable` / `fromJunction` membership sources are on the [Supabase adapter](https://permdock.dev/docs/adapters/supabase) and [Supabase hook](https://permdock.dev/docs/adapters/supabase-hook) pages.
