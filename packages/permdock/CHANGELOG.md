# permdock

## 0.1.0-next.2

### Minor Changes

- a9802af: Permission-level custom roles bounded by a ceiling. `CustomRole` gains `grants` (`{ permission, effect? }`, no conditions) and an optional `team`; `includes` is now optional. Every custom role resolves through `resolveCustomRole(policy, role)`: its included roles' grants plus its own allows, minus its own denies, intersected with the code allows of the declared `assignable` roles in its scope. Grants inherit the declared grant's condition, approval and limit, and keys outside the ceiling are dropped and reported by `validateCustomRole` and `permdock doctor` PD023.

  `assignablePermissions({ tenant? })` joins `assignableRoles`: both intersect the ceiling (narrowed by `RoleSource.assignable`) with what the subject holds, and a held role or granted permission with `meta.manageRoles: true` lifts the intersection. Snapshots carry resolved custom-role grants and a per-tenant `assignable` list, read by `fromSnapshot` and the new `useAssignablePermissions` hook (Vue, Solid, React Native; `assignablePermissions` store in Svelte). `testRoleSource` accepts `{ policy }` to check custom-role grants against the ceiling.

  Behaviour change: an `includes` entry is now bounded by the ceiling too, so a custom role that included a global or non-assignable role no longer reaches that role's grants, and `assignableRoles()` now also lists assignable roles whose every allow the subject holds.

- e78fe1c: Custom roles in generated RLS. `permdock rls generate --custom-roles` (or `rls.customRoles: true`) makes `permitted_tenant_ids` and `permitted_team_ids` resolve tenant-defined custom roles as well: from the new `custom_role_permissions` and `custom_role_includes` tables in `database` mode, or from a compact `memberships[].grants` claim in `jwt` mode (off unless the flag is set). Both go through `permdock_custom_keys` and a generated `permdock_ceiling` view of the assignable declared roles, so a row or claim entry outside the ceiling never widens access, and the database agrees with `resolveCustomRole`. `authorizeSql({ customRoles: { declared } })` answers tenant requests from custom roles, and `--rbac supabase --custom-roles` passes it through.

  `customRoleClaim(roles)` builds the claim map for a token hook. `rls verify` fixture files accept `customRoles` (resolved in-process, sent in the claim, and seeded into the tables in `database` mode), and `rlsParity` accepts `customRoles`. An included role's denies now apply to a custom role only in the custom role's own scope, matching what RLS can evaluate. Output without `--custom-roles` is unchanged.

- eddcade: Approvals refuse the requester by default. `approval: 'human'` and `approval: { by }` now refuse the request's principal as approver as well as its actor (`approver-is-principal`), in `assertApprover`, `ApprovalStore.resolve`, `resolveApproval` and `approvalsHandler`. A grant that wants the user to confirm their own agent's call opts out with `approval: { distinct: false }`, and `permdock doctor` PD024 (`--only self-approval`) warns on each opt-out. `requireDistinctApprover` stays as a handler-wide floor that refuses the principal even on an opted-out grant. A hosted grant that sets `distinct: false` on a permission a code allow guards with an approval is dropped as `weaker-approval`. `testApprovalStore` checks that a custom store refuses the principal on every approval shape and accepts it only with `distinct: false`.

  Behaviour change: an approval request without `approvers.distinct` now refuses its principal. Set `distinct: false` on the grant to keep the old behaviour.

- d59c797: `permdock rls generate` compiles role checks to per-statement helpers. Policies call `permdock_has('<grant key>')` for global roles and `"<tenant col>" in (select permitted_tenant_ids('<grant key>'))` (or `permitted_team_ids`) for scoped roles: `security definer`, `search_path = ''` SQL functions over a seeded `role_permissions (role, permission, grant_key, scope, effect)` table, which Postgres evaluates once per statement (an InitPlan or hashed SubPlan) instead of once per row. `--authorize database|jwt` now drives them for every dialect. Tenant grants with only a claim and global grants with no condition no longer skip the role check.

  Policies collapse to one permissive and one restrictive policy per table and command (`{table}_{op}`); `--policy-per-role` keeps the per-role layout and `--policy-name` sets a template. The tenant claim is cast to `--tenant-type` (default `uuid`). Top-level `definePolicy({ grants })` compile too, and a grantee Postgres cannot see fails with the permission named. `--rbac supabase` builds on the same helpers; `authorizeSql` reads the shared `role_permissions`. `rls import` reads both layouts back to roles and `memberOf`, `rls verify` passes roles and memberships in the claims and inserts whole rows, and `rlsParity` sets the role and memberships GUCs.

- e918765: One package: the CLI moves into `permdock`. The `permdock` binary is the package's `bin`, `@permdock/cli` becomes `permdock/cli` (`defineConfig`, `run`), `@permdock/cli/unplugin` becomes `permdock/unplugin`, and `permdock/next/plugin` runs `collect` itself instead of resolving `@permdock/cli`. `permdock`, owned by the `scaledockhq` npm organisation, is the only package name.

  Runtime entry points (`permdock`, `permdock/next`, `permdock/jwt`, ...) still depend on `@standard-schema/spec` only: every command is loaded on demand, and `tests/bundle` fails if a runtime entry reaches a CLI or test-runner package. Dependency cost, measured as npm unpacked size:

  - `oxc-parser` is the package's one other dependency, because `collect`, `usage`, `doctor`, `catalog`, `cloud push` and the build hooks parse source: 1.43 MB, plus `@oxc-project/types` (0.04 MB), plus one platform binding (1.59 to 2.12 MB; darwin-arm64 1.76 MB, linux-x64-gnu 2.12 MB). That is about 3.1 to 3.6 MB per install.
  - `ajv` (1.03 MB unpacked) and `yaml` (0.69 MB) are bundled into the lazily loaded OpenAPI command chunks instead of being installed.
  - `pgsql-parser` (2.83 MB with `libpg-query` WASM and `pgsql-deparser`), `pg` (0.10 MB) and `unplugin` (0.08 MB plus its dependencies) are optional peers. `permdock rls import`, the `--db` modes and `permdock/unplugin` print the install line when the peer is missing.

  Generated catalogs record `generator: permdock@<version>`, and generated barrels say `@generated by permdock`.

- 4d41dac: The test runners move into `permdock`: `@permdock/testing` is now the `permdock/testing` subpath, with `permdock/testing/saas` and `permdock/testing/saas/permissions`. Vitest is an optional peer, and no application entry imports the testing entries. Import from `permdock/testing` and drop the `@permdock/testing` dev dependency; `permdock` is the only package name.

## 0.1.0-next.1

### Minor Changes

- 2ba3a26: Export `coveredByDelegation(permission, delegation, resourceId?, hasActor?)` from `permdock`: the delegation coverage check `decide` uses for OAuth `scopes`, RFC 9396 `authorizationDetails` and GNAP `access`. It returns `undefined` when covered, otherwise `no-delegation` or `not-delegated`, and `permission` needs only `scope`, `resource` and `action`, so an external PDP such as the PermDock Cloud AuthZEN endpoint can reuse it.

## 0.1.0-next.0

### Minor Changes

- 93889da: Catalog v1 carries a top-level `fingerprint` and per-permission `approvals`. `catalogFingerprint(catalog)` is exported from `permdock`: base64url SHA-256 over canonical JSON without `generatedAt`, `generator`, `fingerprint` and `usages`, so the CLI version and call sites no longer change it. `permdock collect --check` ignores `generator`.
- 8b0c917: `cloud().approvals` implements `cancel(filter, meta)` over `POST /v1/environments/:env/approvals/cancel`, so session revocation rejects pending Cloud approvals in one call.
- 8bfa791: `cloud().policies.refresh()` verifies the `permdock-policy+jwt` against the Cloud environment URL (`iss` and `aud` are `<PERMDOCK_CLOUD_URL>/v1/environments/<env>`; `exp` is 24 hours after issue). The `audience` option is removed. `cloud()` exposes the environment URL as `issuer`, `jwks` is the environment's JWK Set URL, and `cloudEndpoints()` resolves both without a key. The policy JWS fixture in `@permdock/testing` follows the new claims.
- 80db0c7: `cloud().snapshots.get()` requests `application/jwt` and returns only a compact `permdock-snapshot+jwt`; an unsigned snapshot body now throws instead of being parsed.
- e9a80d6: Add `toCsvRow(event)` and `CSV_COLUMNS`: the pinned CSV export row for decision and approval events, shared by the Cloud export and self-hosted sinks.
- 223abdb: First release of PermDock: typed, portable permissions for apps, APIs and agents, with the `permdock` core and adapters, the `@permdock/cli` build tooling and the `@permdock/testing` runners.
- f6179a9: `dev.permdock.catalog` drift findings are typed `CatalogFinding` objects `{ code, permission, grant? }` with `code` one of `permission-removed`, `not-hostable`, `grantee-removed` or `approval-tightened`; `parseCloudEvent` and `verifyWebhook` reject the earlier free-text strings.

### Patch Changes

- e600592: Document the PermDock Cloud contract v1: `client`, `admin` and `export` key kinds, the authoring routes (`/hosted-grants`, `/directory/*`, `/connectors`, `/export`), the environment's JWKS and OIDC Discovery, RFC 8693 token exchange at `<env URL>/oauth/token` minting RFC 9068 access tokens, the raw sink body the Cloud envelopes as CloudEvents, and `membership` events with `source: 'cloud'`.
- c8c5c77: The `cloud()` sink bounds its re-queue while the Cloud is unreachable (`capacity`, default 10 000, oldest dropped first), matching `memorySink`.
