---
'permdock': minor
'@permdock/cli': patch
'@permdock/testing': minor
---

Resource roles are keyed by resource. A role held on folder `f1` no longer grants a child row whose own id is `f1`, in `can()`, on snapshot clients or in `permdock rls generate`. It now grants the folder's children through their parent field, and a membership on an ancestor of the role's resource counts along the declared chain. `memberOf` `parents` entries may be keyed (`{ field, resource }`, type `MemberOfParent`).

`toWhere` returns the rows `filter()` accepts on Drizzle, Kysely and Prisma 7. NULL and negation follow the in-memory rules (`not` keeps NULL rows; `ne` and `notIn` never match NULL). `where()` binds `principal.*` / `context.*` references and carries its subject, so `memberOf` compiles without a second argument. `contains` escapes `%` and `_` and matches array columns by element (Drizzle `= any(...)`, Kysely `listFields`). Membership `exists` joins bind the role list, the active tenant, a `resource` column and `now` in whole Unix seconds. Tenant `memberOf` honours the active tenant in memory. Drizzle's `toWhere` accepts any table object. Prisma gains `requiredFields` and drops the `memberships` option, which never took effect. `@permdock/testing` adds `ormParity`.
