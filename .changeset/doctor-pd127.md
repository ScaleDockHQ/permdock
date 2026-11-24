---
"permdock": minor
---

`permdock doctor` adds PD127: a warning when `rls` is configured and the Supabase project config sets `[db] driver` to `sqlite` or `sqlite-postgres` (Supabase Lite), where the generated policies and helpers do not exist.
