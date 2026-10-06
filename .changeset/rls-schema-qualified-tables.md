---
"permdock": patch
---

`rls.tables` accepts schema-qualified names such as `integrations.webhook_endpoints` end to end. `permdock rls verify` (with `--db` and in the pgTAP output), its field view reads and `rlsParity` from `permdock/testing` now quote `schema.table` as a schema and a table instead of refusing it as an unsafe identifier, so a table a package installs in its own schema can be verified like one in `public`. With `--target drizzle` or `--target prisma`, the default export or model name of a schema-qualified table is the table name without its schema; `rls.drizzle.exports` and `rls.prisma.models` still override it. Nothing changes for unqualified names.
