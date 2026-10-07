---
"permdock": minor
---

Breaking: an allow with `requires` now counts for a delegated caller (an OAuth client or an API key) only when its scopes cover every required permission, in `can()`, `where()` and snapshots, matching what `rls.apiKeys` already enforced in the database. A key scoped to `drive:read` without `file:read` no longer reads the drives a `requires: file.read` share reaches in process; it still reaches the grants of `drive.read` without `requires`. A key that covers all required permissions keeps using such an allow whether or not it covers the granted permission.
