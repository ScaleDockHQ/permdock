---
"permdock": minor
---

`rls.customRoleWrites.roles` writes its cascade trigger as `create or replace trigger`. `member_team_ids_for` is granted to `supabase_auth_admin` only when `supabase.hook.security` is `invoker`, which is the default; a `definer` hook runs it as its owner. A scope with no memberships table returns two columns from the grant-set helpers, so a team scope without a team table no longer fails to create `permitted_<scope>_permission_keys`.
