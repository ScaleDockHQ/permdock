---
"permdock": patch
---

`permdock_custom_role_system_guard` lets a signed-in caller insert or update a platform role row, one with no tenant, that has the `skip` column set, as long as the row stays a platform row. Since 0.34 it refused these writes with `42501` `system-role`, so platform staff could no longer create platform catalog roles through the Data API under the app's own policies. `skip` has no effect on a platform row, so the guard did not need to cover it. Moving a row that has `skip` into or out of a tenant is still refused. Rerun `permdock rls generate`.
