---
"permdock": minor
---

`rls.tableReads[].tenantFor` lists the keys under which a `row` table reads as `tenant`. `authorizationProvider({ tables: true, widened: true })` lists such a table as `tenant`, and `authorizationHooks({ widened: widenedKeys(manifest) })` makes `shareKey` answer `null` for a caller who holds none of them.
