---
'permdock': minor
---

`supabase.hook.claims` adds claims other packages own to the generated Custom Access Token Hook, for example `{ features: 'better_supabase.feature_claims' }`. Each value is a schema-qualified `(uuid) returns jsonb` function; `null` leaves the claim out. `permdock supabase hook generate` refuses a claim name PermDock or Supabase Auth writes (`roles`, `memberships`, the tenant claim, `sub`, `role` and the rest) and an unqualified function, grants `supabase_auth_admin` `execute` on each function, keeps the claims outside the memberships budget, and writes none of them for a suspended user.
