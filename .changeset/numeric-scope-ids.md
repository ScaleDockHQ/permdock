---
"permdock": patch
---

Scope ids compare as text. A row whose key column is a number (a `bigint` id read through supabase-js) now matches a membership whose id is that number's text, in `can`, snapshots, `heldRoles({ id })`, custom-role matching, `decideRoleChange`, `activate` and capabilities; before, the check denied with `scope`. A membership whose `id`, `within` or `on.id` is a number or bigint is read as its text instead of being dropped.
