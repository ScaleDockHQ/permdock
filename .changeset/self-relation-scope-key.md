---
"permdock": patch
---

Every scope-key read in `can`, `where()` and snapshots goes through the `relations.self` lookup, so a resource that declares only `self` is checked on its own id at a nested scope too.
