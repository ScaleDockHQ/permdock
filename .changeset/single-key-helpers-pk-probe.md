---
"permdock": patch
---

Generated helpers that check one grant key now probe `role_permissions` by its primary key and check the signed-in user's active row once per statement, which makes `permitted_<scope>_ids(p_grant)` and `permdock_has(p_grant)` about 30% faster for users with many memberships. Run `permdock generate` to pick up the new helper bodies.
