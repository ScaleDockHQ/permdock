---
"permdock": minor
---

`authorizationProvider({ permissionFilters: true })` emits better-supabase 0.86.0's `permissionFilters` from `rls.tenantPureHelpers`, and each helper entry carries `keyPosition`. better-supabase 0.85 refuses the field, so it stays off by default.
