---
"permdock": patch
---

Cache PowerSync rows per query and coalesce watch bursts. Watch-triggered reads refresh only changed queries, concurrent reads share a refresh, and unchanged data reuses the snapshot. Explicit foreground reads still refresh every query, and membership expiry rebuilds the snapshot on the next read.
