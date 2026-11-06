---
"permdock": minor
---

Breaking: an insert into a membership roles table bumps `authz_ver`, and a moved row bumps the old holder and the new one. `supabase.hook.memberships` defaults to the `rls.memberships` scope tables.
