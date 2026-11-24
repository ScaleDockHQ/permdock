---
"permdock": minor
---

`permdock/server`, `permdock/supabase/middleware` and `permdock/next` add `tenantFromPath`, which resolves a tenant slug in the URL to a tenant id through the app's `resolve`. The id is the active tenant only when the subject holds a membership there; an unresolved slug leaves the instance without a tenant instead of the token's.
