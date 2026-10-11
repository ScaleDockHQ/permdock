---
"permdock": minor
---

`rls generate --backfill-out` copies existing custom roles named in `rls.customRoles.from` into the custom-role tables, and `rls.triggers` and `rls.audit` declare app-owned and audit triggers on generated tables, which now carry an identity `id` primary key. `rls migrate --retire-out` drops each `rls.migrate.tables` table with its refresh triggers once nothing reads it, and `doctor` reports such a table as PD066 until then.
