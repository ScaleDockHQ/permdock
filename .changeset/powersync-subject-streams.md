---
"permdock": minor
---

`permdock powersync generate` adds `permdock_*` Sync Streams for the signed-in user's own membership and global-role rows, the roles tables they reference, and, with `rls.customRoles`, the custom roles of the user's tenants: the rows `localSnapshot` needs. With `powersync.manifest` set, it also writes `localSnapshotManifest(policy)` to that path, which `verify` and doctor check PD058 compare as JSON. `powersync verify` passes a fixture's `subject.claims` to `auth.parameter()` and fails when an own-rows stream syncs another user's rows. PD058 reports a config that does not compile instead of staying silent. The new `powersyncSource(db, { manifest, queries, read })` in `permdock/react-native` builds the local snapshot from PowerSync `db.watch` queries.
