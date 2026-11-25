---
"permdock": minor
---

The Supabase hook writes `suspended_in`, the tenants where the user is a member and the tenant is suspended, outside the memberships budget; `permdock_subject()` returns it as `suspendedIn` and `principal.suspendedIn` exposes it. RLS still denies.
