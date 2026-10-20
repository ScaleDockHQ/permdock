---
"permdock": patch
---

Doctor PD054 compiles the `role_permissions` rows from the same context `permdock rls generate` builds, so a levelled resource no longer reports the rows generate writes as missing or stale. It also reads the rows of an `rls.seeds: 'view'` view.
