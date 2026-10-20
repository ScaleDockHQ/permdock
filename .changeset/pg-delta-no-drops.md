---
"permdock": patch
---

`rls generate --split` and `supabase hook generate` under pg-delta write no `drop trigger` or `drop policy` statement in a declarative file: triggers are `create or replace trigger`, policies a plain `create policy`.
