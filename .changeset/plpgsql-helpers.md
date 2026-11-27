---
"permdock": minor
---

`permdock rls generate` writes the helpers without a memo in PL/pgSQL instead of SQL: `member_<scope>_ids`, `member_<scope>_ids_for`, `permitted_<scope>_ids_by_permission`, `permitted_<scope>_permission_keys`, `permdock_has_for`, `permitted_<scope>_ids_for` and the `rls.memo: 'none'` helpers. Postgres never inlines a function with a `set` clause, so it planned a SQL helper again in every statement that called it; a PL/pgSQL helper keeps its plan for the session. Each body starts with `#variable_conflict use_column`, so the answers do not change. Rerun `permdock rls generate` and add a migration for the changed functions. On CentraKit, `member_organization_ids()` alone took a dashboard payload from 137 to 109 ms.
