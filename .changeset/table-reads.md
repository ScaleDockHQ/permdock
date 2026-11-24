---
"permdock": minor
---

`permdock supabase inspect` writes `rls.tableReads` into `permdock.manifest.json`: per table, whether its select policies filter by tenant alone (`share: 'tenant'`) or by row, with the rules that make it `row`. `authorizationProvider({ tables: true })` reads it, and doctor `PD128` fails when the manifest marks a table `tenant` that its policies no longer allow.
