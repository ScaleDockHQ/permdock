---
"permdock": minor
---

`VersionStore` takes better-supabase's shape: `get` answers `{ version, at }` and `set(id, version, at)` carries the database read time, so `maxStaleMs` counts from the read on every instance. Breaking for a custom store, which must store `at`. `runtimeCacheVersionStore` and `postgresCacheVersionStore` are new.
