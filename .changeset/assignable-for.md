---
"permdock": minor
---

Add `assignableFor(policy, user, { tenant })`, which returns the `assignable` entry of one tenant on demand, the entry `snapshotFor(…, { tenants: "all" })` carries for it. `snapshotFor`'s `v` option now accepts only `1`, the one wire version, and throws a `TypeError` for anything else instead of ignoring it. No generated SQL changes.
