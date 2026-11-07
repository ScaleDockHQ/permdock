---
"permdock": minor
---

Breaking: the hook reader `membership_entries_for` is `memberships_for`. It is `security definer` and execute stays with `supabase_auth_admin` only. Re-run `permdock supabase hook generate`.
