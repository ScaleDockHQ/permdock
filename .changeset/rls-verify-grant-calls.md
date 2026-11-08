---
"permdock": minor
---

`permdock rls verify --advisors --grant-calls --db-url-stdin` also lists the executions of the statements that name each permission key, read from `pg_stat_statements`, and adds `grantCalls` to the JSON. It only reads. `permdock generate --only rls` rewrites nothing and no data migration is needed.
