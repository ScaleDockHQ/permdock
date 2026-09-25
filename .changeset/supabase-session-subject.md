---
'permdock': minor
'@permdock/testing': minor
---

`permdock/supabase` adds `subjectFromSupabaseSession(session, options)` for any verified `{ kind, claims }` session object (for example better-supabase's `AuthSession`). Only `kind: 'user'` maps, and PermDock imports nothing from the session library. A top-level role or tenant claim set to `null` (what the RBAC hook writes for a user with no role row) now falls back to `app_metadata` instead of shadowing it. `@permdock/testing` exports `supabaseClaimFixtures` in the hook's claim shape and `supabaseMembershipsBudget` (1 KB, about 15 memberships).
