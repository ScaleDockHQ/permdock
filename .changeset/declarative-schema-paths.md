---
"permdock": minor
---

Files under the pg-delta schema directory are declarative SQL, including `{part}` paths and `supabase.hook.out`. `create table` and `create unique index` drop `if not exists`, and a trigger is `create or replace trigger`.
