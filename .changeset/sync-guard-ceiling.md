---
"permdock": minor
---

The `rls.customRoles.from.sync` guard triggers now refuse a signed-in write of an entry PermDock cannot hold, as `permdock_replace_custom_role_grants` does: `22023` with `outside-ceiling`, `unknown-permission`, `unknown-level` or `unknown-role`. Before, the guard skipped such an entry and the after-row sync dropped it with a warning, so the legacy table kept a row that granted nothing. Writes without a caller (migrations, jobs, backfills) still drop with a warning. Regenerate the RLS SQL to pick this up.
