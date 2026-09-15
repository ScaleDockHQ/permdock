# @permdock/cli

## 0.1.0

### Minor Changes

- 42012ff: Add `simulate({ arazzo, openapi })` for Arazzo 1.1 workflows and `permdock arazzo check` for catalog holes (no subject).
- 4695aa9: Ship `@permdock/cli` with collect, catalog, usage, doctor and skills, plus collect-only Next and unplugin hooks.
- a7c3fb6: Add `permdock/openapi` and `permdock openapi emit` for OpenAPI 3.2 documents, Overlay 1.1/1.2, and the pinned 3.3 Security Profile draft.
- Publish metadata, ranged optional peers (including `@opentelemetry/api`), and a provenance-enabled release workflow.
- 12daecf: Add `permdock rls generate | import | verify` for Postgres row-level security.
- Typed vocabulary (`defineRoles`, `definePlans`), `to:` grantee selectors, `principal` refs, `actions()`, and snapshot v3.

  Breaking before 1.0: `Role` is now the vocabulary leaf (`RoleBinding` is the grant list); `roles()` / `assignable()` rename to `heldRoles()` / `assignableRoles()` and return `Role[]`; `Grant.role` becomes `Grant.to`; snapshots emit `v: 3`.

- Add `sqlFunction` conditions with an in-memory twin so SQL-authority RLS helpers stay portable. `permdock rls` generates the call, imports mapped functions via `pgsql-parser`, and `verify --db` proves the twin. PermDock Cloud must accept the new node in snapshots and decision events.
- Remove the `subject` condition-ref builder and the `subject.*` ref prefix. `principal` and `context` are the only condition refs, `permdock rls generate` compiles them and `permdock rls import` emits `principal.*`. `Role` is no longer an alias of `RoleBinding`.

  Breaking before 1.0: rename `subject.id` to `principal.id` and `subject.context.<key>` to `context.<key>` in policies. The `definePolicy` `subject` option is unchanged (ADR 0045).

### Patch Changes

- be69cbb: Document collect-only unplugin recipes for Nuxt, Astro, React Router, TanStack Start, and Effect (no new packages).
