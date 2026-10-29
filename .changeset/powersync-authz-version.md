---
"permdock": minor
---

`powerSyncSource` returns a `PowerSyncSnapshotSource` with `authzVersion()`, the user's synced `authz_version`. `nativeRefresh({ powersync: { source } })` reuses it for the foreground catch-up instead of its own query.
