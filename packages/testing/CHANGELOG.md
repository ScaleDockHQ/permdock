# @permdock/testing

## 0.2.0

### Minor Changes

- 71bdf71: Open the 0.2 cycle after the 0.1.0 release.
- f9e31e1: Typed vocabulary (`defineRoles`, `definePlans`), `to:` grantee selectors, `principal` refs, `actions()`, and snapshot v3.

  Breaking before 1.0: `Role` is now the vocabulary leaf (`RoleBinding` is the grant list); `roles()` / `assignable()` rename to `heldRoles()` / `assignableRoles()` and return `Role[]`; `Grant.role` becomes `Grant.to`; snapshots emit `v: 3`.

### Patch Changes

- 45fb5d2: Add `sqlFunction` conditions with an in-memory twin so SQL-authority RLS helpers stay portable. `permdock rls` generates the call, imports mapped functions via `pgsql-parser`, and `verify --db` proves the twin. PermDock Cloud must accept the new node in snapshots and decision events.

## 0.1.0

### Minor Changes

- f9db032: Ship `permdock/approvals` so pending human gates live in a pluggable store with an in-memory default, Fetch approver routes, and `PermDock-Approval` resume helpers that never change `decide`.
- 9a8930b: Ship `permdock/jwt` so bearer tokens become subjects through an optional `jose` peer, and add verifier/signer conformance runners plus signed-output fixtures.
- 9cd0590: Add the `permdock` core package (definitions, portable conditions, tenancy, `createPermDock`, snapshot v3) and `@permdock/testing` (policy matrix and core conformance runners).
- Thread `Policy` user and principal generics through core and every adapter `createPermDock` so a typed policy is accepted without a cast.
- Publish metadata, ranged optional peers (including `@opentelemetry/api`), and a provenance-enabled release workflow.
- 41d4112: Add quota grants with a pluggable `LimitStore`. `can` never consumes; a thenable or thrown store denies with `limit-unavailable`.
- 668c9dd: Add `rlsParity` to compare `can()` with Postgres RLS as allowed, filtered, or rejected.
- 1ff89ca: Add `permdock/scim`: RFC 7644 `/Users` and `/Groups` receiver, `DirectoryStore`, `directoryMembershipSource`, and `testDirectoryStore`.
- Rename the snapshot TypeScript type from `SnapshotV2` to `Snapshot`. The wire field `v` is unchanged.
- Typed vocabulary (`defineRoles`, `definePlans`), `to:` grantee selectors, `principal` refs, `actions()`, and snapshot v3.

  Breaking before 1.0: `Role` is now the vocabulary leaf (`RoleBinding` is the grant list); `roles()` / `assignable()` rename to `heldRoles()` / `assignableRoles()` and return `Role[]`; `Grant.role` becomes `Grant.to`; snapshots emit `v: 3`.

### Patch Changes

- c4a13ce: Evaluate GNAP `delegation.access` against grants, map RFC 7662 / RFC 9767 introspection in `subjectFromIntrospection`, and reject a claimed `act` nest that does not verify (`invalid-chain`).
- 370c42d: Add `permdock/drizzle`, `permdock/prisma` and `permdock/kysely` `toWhere` compilers, including `memberOf`.
- Add `sqlFunction` conditions with an in-memory twin so SQL-authority RLS helpers stay portable. `permdock rls` generates the call, imports mapped functions via `pgsql-parser`, and `verify --db` proves the twin. PermDock Cloud must accept the new node in snapshots and decision events.
- Remove the `subject` condition-ref builder and the `subject.*` ref prefix. `principal` and `context` are the only condition refs, `permdock rls generate` compiles them and `permdock rls import` emits `principal.*`. `Role` is no longer an alias of `RoleBinding`.

  Breaking before 1.0: rename `subject.id` to `principal.id` and `subject.context.<key>` to `context.<key>` in policies. The `definePolicy` `subject` option is unchanged (ADR 0045).
