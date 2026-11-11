---
"permdock": patch
---

The token hook's active tenant source no longer depends on run order. A `better-supabase.config.*` that throws while loading, for example because it reads a `permdock.manifest.json` or catalog that `permdock generate` has not written yet, was treated as absent, so the first run wrote the hook against `app_metadata.active_<first scope>` and the next against `app_metadata.tenant_id`. It now counts as a better-supabase config that sets no claim, and the CLI prints a `[better_supabase_config]` warning with the load error.
