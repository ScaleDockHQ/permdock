---
"permdock": minor
---

Default the token hook's active source to `app_metadata.<rls.tenantClaim ?? tenant_id>` when a readable `better-supabase.config.*` exports an object. Generation, inspection and PD078 share detection. Explicit sources still win; absent, invalid or unreadable configs keep the plain Supabase `app_metadata.active_<first scope>` default.

This changes the default for detected better-supabase projects. To keep the old source, set `supabase.hook.activeFrom` explicitly before regenerating SQL and the manifest. Regenerate and deploy both together; no wire-format fields change.
