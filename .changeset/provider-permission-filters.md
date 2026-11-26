---
"permdock": minor
---

`permdock supabase inspect` writes `rls.permissionFilters`: `permdock_<root>_has_active(p_grant)` and `permitted_<root>_permission_keys_active(p_keys)`, which call the two-argument helpers with the tenant the token names. `authorizationProvider` fills better-supabase's `permissionFilters` from that list. Passing `permissionFilters: true` is no longer accepted. The two-argument helpers stay out of the list, because better-supabase 0.87 checks the key argument only.
