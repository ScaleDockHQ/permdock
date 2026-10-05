---
"permdock": minor
---

`rls generate` adds helpers that take a permission key instead of a grant key: `permdock_has_permission(p_permission)`, one `permitted_<scope>_ids_by_permission(p_permission)` per scope, and `grant_keys(p_permission, p_scope, p_effect)`, plus `_for(p_user, p_permission)` forms in `database` mode. They answer with the permission's unconditional allows minus any deny and map a former key to the current one, so hand-written SQL no longer spells positional `#n` grant keys, which change when a role's grants change. A permission whose allows on a scope all carry a condition answers nothing there. `rls generate --shims` no longer answers from a break-glass grant key, which only the break-glass read may use.
