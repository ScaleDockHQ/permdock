---
"permdock": patch
---

`rls.tableReads` leaves out a table a later migration drops and follows `alter table … rename to`, and `permdock rls verify --shadow` finds `supabase/schemas` above the package directory in a monorepo.
