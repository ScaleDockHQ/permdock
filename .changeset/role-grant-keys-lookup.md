---
"permdock": minor
---

The generated helpers read a declared role's grant keys through one function, `permdock_role_grant_keys(scope, role)`, where each body joined `role_permissions` itself. `permdock generate --only rls` rewrites the helpers file, and the decisions are unchanged; no data migration is needed. Run `permdock generate` and apply the new migration; the function is created with the helpers.
