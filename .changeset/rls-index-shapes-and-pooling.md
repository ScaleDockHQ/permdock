---
"permdock": minor
---

`permdock generate` writes membership indexes as `(user, scope) include (role) where disabled_at is null`, and under pg-delta an existing schema directory always gets `indexes.sql`. Memoised `permitted_<scope>_ids` helpers carry `rows 10` for the planner, and the defaults seed migration sets a 5 s `lock_timeout` and 30 s `statement_timeout`. `permdock doctor` adds PD098, a database URL on the transaction pooler (port 6543), and PD099, a hand-written `update` policy on a table with no `select` policy.
