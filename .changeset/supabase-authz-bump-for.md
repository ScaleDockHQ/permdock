---
"permdock": patch
---

The Supabase token hook migration adds `permdock_bump_authz_version_for(p_users uuid[])`, which bumps `authz_ver` once for each listed user. A trigger on a table the hook does not read, such as better-supabase's `entitlement_members`, can now invalidate its users' tokens. The function is `security definer`, and no client role may execute it. The membership triggers now call it. The manifest names it in `authzVersionBump` when `authzVersion` is true.
