---
"permdock": patch
---

`authorizationProvider` from `permdock/better-supabase` now checks custom roles in its `canAssign` and `canAssignFor` templates. When the manifest's `rls.customRoles` is set and the tenant scope is a root scope, they call `permdock_can_assign_any` and `permdock_can_assign_any_for` at the tenant scope instead of the declared-role helpers, so better-supabase's `can_assign` and `can_assign_as` accept a custom role the caller may assign. Below the root scope the provider keeps the declared-role check and reports it in `problems`. Regenerate `permdock.manifest.json` with `permdock supabase inspect --out` so it lists `rls.customRoles` and the helpers.
