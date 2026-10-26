---
"permdock": minor
---

In a project with a `better-supabase.config.*`, the token hook's default `supabase.hook.activeFrom` and doctor PD078 now read the claim better-supabase writes: `auth.organization.claim` (or `claims.tenant` in a flat config), then `rls.tenantClaim`, then `tenant_id`. A project that renames the claim in better-supabase only now gets a hook that reads it; regenerate the hook SQL and manifest together.
