---
"permdock": minor
---

`supabase.hook` also emits `<helpers schema>.permdock_subject()`, which returns the signed-in user's `subject_for` record to `authenticated` and `null` otherwise. `authorizer` reads better-supabase's `runtime.seed` and, when it names the token's user at the live version, seeds the subjects cache so the instance makes no `subject_for` call. `permdockFor` results carry `subject`.
