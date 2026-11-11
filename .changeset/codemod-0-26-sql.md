---
"permdock": minor
---

`permdock codemod 0.26` renames `permitted_<resource>_row(` to `can_<resource>(`, removes `::text` around a helper call, deletes `own_subject()`, and moves `{ tableOf }` onto the owner's `also` list.

It also drops `rls.actions` entries that repeat the inferred command (`remove: "none"` stays) and deletes a `canAssign` that names `permdock_can_assign_any` from `better-supabase.config.*`. `roleThrough` and `blocks.permissions.disabled` there are follow-ups, not deletions: the provider supplies them only for a matching role source and under `blocks.permissions.model: "provider"`. A removed generate command keeps each flag `permdock generate` does not take, such as `--out`, and reports it as a follow-up.
