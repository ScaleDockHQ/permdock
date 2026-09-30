---
'permdock': minor
---

`subjectFromSupabase` maps more of the token. `plans: '<claim>'` reads the active tenant's entry of a per-tenant plans claim (better-supabase's `features`) into `principal.plans`. `act` and the OAuth `client_id` of a third-party app become an `oauth-client` actor with `scope` as `delegation.scopes`, so such a token only reaches what its scopes delegate. A `memberships` entry the reader cannot use is still dropped, and now reports `membership-dropped` to the new `onAuth` option; `permdock doctor` PD039 lists those entries from the `doctor.claims` samples. `supabaseClaimFixtures.betterSupabase` is the canonical claim set better-supabase 0.2 emits.
