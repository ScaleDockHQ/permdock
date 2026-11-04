---
"permdock": minor
---

`permdock supabase hook generate` writes `membership_entries_for(p_user)` and `global_roles_for(p_user)` in the hook schema. The hook and `subject_for` call them instead of repeating the membership union and the global-roles aggregate. Re-run `hook generate` and apply the migration; the token and `subject_for` output are unchanged.
