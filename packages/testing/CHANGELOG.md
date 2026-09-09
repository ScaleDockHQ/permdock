# @permdock/testing

## 0.1.0

### Minor Changes

- f9db032: Ship `permdock/approvals` so pending human gates live in a pluggable store with an in-memory default, Fetch approver routes, and `PermDock-Approval` resume helpers that never change `decide`.
- 9a8930b: Ship `permdock/jwt` so bearer tokens become subjects through an optional `jose` peer, and add verifier/signer conformance runners plus signed-output fixtures.
- 9cd0590: Add the `permdock` core package (definitions, portable conditions, tenancy, `createPermDock`, snapshot v2) and `@permdock/testing` (policy matrix and core conformance runners).
- Thread `Policy` user and principal generics through core and every adapter `createPermDock` so a typed policy is accepted without a cast.
- Publish metadata, ranged optional peers (including `@opentelemetry/api`), and a provenance-enabled release workflow.
- 41d4112: Add quota grants with a pluggable `LimitStore`. `can` never consumes; a thenable or thrown store denies with `limit-unavailable`.
- 668c9dd: Add `rlsParity` to compare `can()` with Postgres RLS as allowed, filtered, or rejected.
- 1ff89ca: Add `permdock/scim`: RFC 7644 `/Users` and `/Groups` receiver, `DirectoryStore`, `directoryMembershipSource`, and `testDirectoryStore`.
- Rename the snapshot TypeScript type from `SnapshotV2` to `Snapshot`. The wire field `v` is unchanged.

### Patch Changes

- c4a13ce: Evaluate GNAP `delegation.access` against grants, map RFC 7662 / RFC 9767 introspection in `subjectFromIntrospection`, and reject a claimed `act` nest that does not verify (`invalid-chain`).
- 370c42d: Add `permdock/drizzle`, `permdock/prisma` and `permdock/kysely` `toWhere` compilers, including `memberOf`.
