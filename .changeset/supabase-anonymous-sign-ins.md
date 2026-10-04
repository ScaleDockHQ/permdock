---
"permdock": minor
---

`subjectFromSupabase` and `subjectFromSupabaseSession` take `anonymousSignIns: 'deny'`, which maps a `signInAnonymously()` token (`is_anonymous: true`) to the anonymous subject, as `rls.anonymousSignIns: 'deny'` does in RLS. `permdock doctor` PD057 warns when `rls.anonymousSignIns` is `'deny'` and a subject call does not pass the option.
