---
"permdock": patch
---

`permdock.grantedPermissions()` evaluates the snapshot grants directly instead of building a snapshot instance, so a server bundle that never calls `fromSnapshot` no longer ships it. `permdock/server` drops 1.3 KB gzipped and `permdock` 1.3 KB.
