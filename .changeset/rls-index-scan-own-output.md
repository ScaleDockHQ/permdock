---
"permdock": patch
---

`permdock generate` without a database no longer reads the `permdock` folders under `supabase/schemas` and the migration folders when it looks for existing indexes and tables, so another plugin's output from the same run never changes the rls notes.
