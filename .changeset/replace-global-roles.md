---
"permdock": minor
---

`permdock rls generate` writes `permdock_replace_global_roles(p_user, p_roles text[])` when `rls.roles` names the global-roles table. It deletes the user's rows whose role is not in the list and inserts the missing ones in one call, for a role editor that saves a whole set. It runs with the caller's rights, so the table's policies and the `rls.assignments` trigger judge each row, and `execute` goes to `authenticated`. A role column that references a roles table (`through`) refuses an unknown key with `unknown-role`. Regenerate the helpers.
