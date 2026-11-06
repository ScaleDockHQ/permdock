---
"permdock": minor
---

`permdock codemod 0.26` renames `permitted_<resource>_row(` to `can_<resource>(`, removes `::text` around a helper call, deletes `own_subject()`, and moves `{ tableOf }` onto the owner's `also` list.

It also drops `rls.actions` entries that repeat the inferred command (`remove: "none"` stays) and deletes `roleThrough`, `permissions.disabled` and a `canAssign` that names `permdock_can_assign_any` from `better-supabase.config.*`.
