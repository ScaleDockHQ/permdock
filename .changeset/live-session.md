---
"permdock": minor
---

Add the `{ subject: { session: { live: true } } }` condition, which holds only while the Auth server still holds the session: `subjectFromSupabase(claims, { liveSession: true })` sets it in process, and `rls generate` compiles it to `permdock.permdock_session_live()`, which reads `auth.sessions` (Supabase dialect only).
