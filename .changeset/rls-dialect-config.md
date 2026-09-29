---
'permdock': patch
---

`permdock rls generate` reads `rls.dialect` from the config, as `permdock rls verify` does; `--dialect` still overrides it. It used to fall back to `supabase` whenever `--dialect` was absent, so a `neon` or `guc` config silently produced Supabase SQL. An invalid `rls.dialect` now exits 2 like an invalid flag.
