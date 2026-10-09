---
"permdock": minor
---

Breaking: two fixtures in `permdock/testing` drop the better-supabase name, with the same contents.

| Before                                                            | After                               |
| ----------------------------------------------------------------- | ----------------------------------- |
| `supabaseClaimFixtures.betterSupabase`                            | `supabaseClaimFixtures.tenantPlans` |
| `better_supabase.feature_claims` in `supabaseHookManifestFixture` | `public.feature_claims`             |
