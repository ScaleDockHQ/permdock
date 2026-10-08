---
"permdock": patch
---

Snapshots carry the roles and plans in `vocabulary` and the permissions in `assignable` as plain objects, with `kind` as an ordinary field. They held the policy's own leaves, whose `kind` is a non-enumerable property, so React refused the snapshot as a Server Component prop in development ("Only plain objects can be passed to Client Components") and a JSON round trip dropped `kind`, so a client `isRole` or `isPlan` check failed on a parsed snapshot.
