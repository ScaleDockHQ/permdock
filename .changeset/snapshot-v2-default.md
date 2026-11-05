---
"permdock": minor
---

`Snapshot` is now one compact form: each distinct grant condition is stored once in `conditions` and a grant is `{ permission, cond }` (an admin snapshot of 1,790 grants drops from 467,592 to 58,412 bytes). **Breaking:** code that reads `snapshot().grants[i].effect` or `.where` directly must call `expandSnapshot`; the `{ v: 1 }` option, `SnapshotInput`, `CompactSnapshot` and the flat public `Snapshot` are removed, and `parseSnapshot` rejects `v: 2`. `schemas/snapshot-v1.json` describes the compact form. Reissue PermDock Cloud snapshot consumers that read the wire format before upgrading.
