---
"permdock": minor
---

`permdock/supabase` exports `supabaseClaims({ tenantClaim? })`, a Standard Schema v1 object for the hook's claim contract, and its types `SupabaseClaims` and `SupabaseMembershipClaim`; `.extend(appSchema)` merges a Zod, valibot or other Standard Schema over it, so a session library validates tokens without copying the shape. `subjectFromSupabase` now reads `grantedBy` and `reason` on memberships, `supabase-claims-v1.json` covers `app_metadata`, `client_id`, `scope` and `act`, and `supabaseClaimFixtures` adds `full`, `portalContact`, `oauthClient` and `actChain`.
