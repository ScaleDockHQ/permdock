---
"permdock": minor
---

`permdock supabase inspect` writes `rls.sharedFunctions` (functions that pass better-supabase's BS430 and read only `tenant` tables) and `rls.tenantPureHelpers` (the helpers that answer the same for callers with an equal `grantFingerprint`); `authorizationProvider({ tables: true, sharedFunctions: true })` emits the functions, and doctor PD137 fails for a listed function that now reads a `row` table.
