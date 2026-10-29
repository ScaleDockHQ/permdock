---
"permdock": patch
---

`authorizationProvider({ requestApprovers: true })` writes `pg_catalog.split_part` in its `isApprover` template, so better-supabase 0.43, which refuses template calls without a schema, accepts it.
