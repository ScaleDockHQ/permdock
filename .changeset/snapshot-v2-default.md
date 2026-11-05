---
"permdock": minor
---

`permdock.snapshot()`, `snapshotFor()` and signed snapshots now default to the compact v2 form, which stores each distinct grant condition once in `conditions` (an admin snapshot of 1,790 grants drops from 467,592 to 58,412 bytes). **Breaking:** code that reads `snapshot().grants[i].effect` or `.where` directly must pass `{ v: 1 }`; `parseSnapshot`, `fromSnapshot` and every client store accept both forms. Adds `CompactSnapshot`, `SnapshotInput` and `schemas/snapshot-v2.json`. Reissue PermDock Cloud snapshot consumers that read the wire format before upgrading.
