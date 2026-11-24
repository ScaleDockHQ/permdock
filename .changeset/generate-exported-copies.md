---
"permdock": minor
---

Under pg-delta, `permdock generate` removes the copies of PermDock's functions and policies that `supabase db schema declarative generate` writes, and never writes into `_custom/` or `_cluster/`. PD095 reports a copy that remains and names both files.
