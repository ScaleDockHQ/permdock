---
"permdock": minor
---

`permdock rls generate --rbac supabase` no longer emits `custom_access_token_hook`: `permdock supabase hook generate` is the one generator of the token hook, so a single function writes `user_role`, `memberships` and the other claims. The scaffold keeps the enums, `user_roles`, `role_permissions`, the helpers and `authorize()`.
