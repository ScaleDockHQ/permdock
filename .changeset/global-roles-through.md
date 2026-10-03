---
"permdock": minor
---

Global roles can be read by key through a roles table: `supabase.hook.roles.role` and the new `rls.roles` accept `{ through: 'roles', on: { role_id: 'id' }, column: 'key' }`. It ships because CentraKit, like most apps that manage roles in a UI, keeps `user_roles (user_id, role_id references roles(id))`, and copying keys into `user_roles` would turn every rename into a data migration. `permdock_has`, `permdock_can_assign` and the token hook join through the table, the hook grants `supabase_auth_admin` a read on it, and `permdock_bump_authz_version_role_keys` bumps every holder's `authz_ver` when a key changes. `rls.roles` defaults to `supabase.hook.roles` and the hook's roles to `rls.roles`; with it set, `rls generate` no longer creates `user_roles`, and `--rbac supabase` refuses it.
