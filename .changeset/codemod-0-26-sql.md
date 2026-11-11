---
"permdock": minor
---

`permdock codemod 0.26` renames `permitted_<resource>_row(` to `can_<resource>(`, removes `::text` around a helper call, deletes `own_subject()`, and moves `{ tableOf }` onto the owner's `also` list.

It also drops `rls.actions` entries that repeat the inferred command (`remove: "none"` stays) and reports `roleThrough`, `blocks.permissions.disabled` and a `canAssign` that names `permdock_can_assign_any` in `better-supabase.config.*` as follow-ups, not deletions: the provider supplies them only for a matching role source, under `blocks.permissions.model: "provider"` and for its own tenant scope, so PD094 decides which values to delete. A removed generate command keeps each flag `permdock generate` does not take, such as `--out`, and reports it as a follow-up.
