---
'permdock': minor
---

`permdock supabase hook generate` warns with PD039 when the helper schema has no generated `permdock_has` or `permitted_<scope>_ids` (read from `rls.out` and the migration folders, or the database with the new `--db` flag). `permdock doctor` PD039 reports the same and, with a `doctor.claims` fixture of sample tokens, each `supabase.hook.claims` entry larger than the memberships budget.
