---
"permdock": patch
---

`permdock supabase hook generate` creates the hook schema before `membership_entries_for` and `global_roles_for`, so the file applies to a database where the schema does not exist yet.
