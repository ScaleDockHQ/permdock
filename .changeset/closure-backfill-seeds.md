---
"permdock": minor
---

Breaking: the closure backfill `select` moves into the seeds migration, and is skipped when `rls.seeds` is `view`. An inherited row helper is defined once. A role enum is a plain `create type`.
