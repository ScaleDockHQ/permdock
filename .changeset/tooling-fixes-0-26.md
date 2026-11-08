---
"permdock": patch
---

`permdock generate --dry-run` and `--check` print one row per changed file with its byte delta, and `--json` files carry `bytes` and `delta`. The hook budget measure in `permdock.manifest.json` now counts `user_role`, the active tenant claim and 20 bytes for `custom_roles_ver`, which the SQL already counted. `permdock supabase` help names `permdock generate --only supabaseHook`, and `PermDockProvider` no longer passes `omitAssignable` to the client provider. No generated SQL changes and no data migration; `permdock generate --only rls` rewrites nothing.
