---
"permdock": patch
---

`permdock rls generate` with `--seeds-out` and `--backfill-out` naming the same migrations directory gives each new file its own version: the seeds migration one second after the newest migration and the backfill one second after that. Both used to get the same version, which Supabase refuses.
