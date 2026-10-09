---
"permdock": minor
---

`permdock powersync generate` writes PowerSync Sync Streams (`sync-config.yaml`, edition 3) from the policy and `rls.memberships`, and `permdock powersync verify --db` fails when a stream syncs a fixture row the policy denies. A resource with a deny grant gets no stream. The `permdock_*` streams sync the signed-in user's own membership and global-role rows, the roles tables they reference and, with `rls.customRoles`, the custom roles of the user's tenants: the rows `localSnapshot` needs. `powersync verify` passes a fixture's `subject.claims` to `auth.parameter()` and fails when an own-rows stream syncs another user's rows.

With `powersync.manifest` set, generate writes `localSnapshotManifest(policy)` to that path. Doctor check PD058 flags a stale streams file or manifest and reports a config that does not compile. `powersyncSource(db, { manifest, queries, read })` in `permdock/react-native` builds the local snapshot from PowerSync `db.watch` queries.
