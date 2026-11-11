---
"permdock": minor
---

Breaking: a `team` or `teams` scope's `member_<scope>_ids_for` is `(p_user uuid, p_active text default null)`, the signature of the `supabase.hook.teams` reader, and its one-argument form is dropped; `global_roles_for` is `security definer`, so the invoker hook no longer grants `supabase_auth_admin` `select` on the membership, roles or referenced user tables. `memberships_for` drops a suspended user's entries and entries in a suspended tenant for every source, a suspended-tenant table turns off the refresh fast path (an explicit `supabase.hook.refresh: 'reuse'` then fails), and `supabase.hook.teams` takes `disabledAt`.
