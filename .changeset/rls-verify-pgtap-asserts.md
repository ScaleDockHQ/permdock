---
"permdock": patch
---

`rls verify --format pgtap` now asserts each fixture against the database instead of writing `select ok(true, ...)`. The script creates `pg_temp.permdock_decision(statement text)`, seeds the fixture custom roles, and for each fixture binds the subject with the same settings as `--db`, runs the statement `--db` runs and checks `is(..., 'granted' | 'denied', ...)` against the outcome `can()` gave; an opaque grant becomes `skip()`. A fixture that disagrees with its `expected` or names an unknown permission now exits `1` without a script. `rls verify --db` keeps custom-role rows that already exist (`on conflict do nothing`) instead of failing on them, and its success line reads `in-process and against the database` when it checked the database.
