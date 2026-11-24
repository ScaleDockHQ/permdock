---
"permdock": minor
---

BREAKING: snapshots are wire format `v: 2` (`schemas/snapshot-v2.json`), and `parseSnapshot`, `fromSnapshot`, `snapshotFromClaims` and React Native storage refuse `v: 1`, so a client discards a cached v1 snapshot and fetches a new one. v2 writes each `requires` holding once in a `requires` table, memberships as `[shape, id]`, `typeLevel` as bit sets over the bundle's `keys`, and leaves vocabulary, scopes and shared grants to the client bundle (`bundle`, `static.shared`). On CentraKit's policy a 12-membership snapshot falls from 19,828 B to 1,850 B and each extra membership from 275 B to 40 B. `readSnapshot(snapshot, { bundle })` returns the flat form, `maxGrantsPerTenant` leaves an oversized tenant to the server (`truncated`), and `getSnapshot` from `permdock/better-supabase` now lists every membership instead of one tenant's.
