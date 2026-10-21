---
"permdock": minor
---

`buildLocalSnapshot`, `localSnapshot` and `powerSyncSource` in `permdock/react-native` now fill `snapshot.assignable` for the active tenant, so `assignableRoles()`, `assignablePermissions()` and `assignableLevels()` answer on the device as the server does. Regenerate the manifest with `localSnapshotManifest(policy)` (or `permdock powersync generate`) to get its new `assignable` section; an older manifest still yields no assignable permissions.
