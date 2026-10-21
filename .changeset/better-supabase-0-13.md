---
"permdock": minor
---

Breaking: `permdock/better-supabase` requires better-supabase 0.13.0 or later, and no peer range caps the major any more (`jose` is `>=6`, `react` is `>=19`). `permdock rls generate` writes `member_<scope>_ids_of(p_user)` on Supabase for a `team` or `teams` scope with membership sources; it answers only for the caller, and `authorizationProvider` fills better-supabase's `teamIdsOf` with it.
