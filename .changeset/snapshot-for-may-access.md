---
'permdock': minor
'@permdock/testing': minor
---

Add `snapshotFor(policy, user, options)`, a synchronous, deterministic snapshot builder for app-owned `'use cache: private'` functions, and `mayAccess(policy, user, permission, { tenant })`, an optimistic check for proxies that returns `false` only when the declared roles provably lack the permission. `describePolicy` accepts `snapshot: true` to assert every cell against the client built from the snapshot.
