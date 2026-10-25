---
"permdock": minor
---

`permdock supabase hook generate` writes `member_team_ids_of(p_user uuid) returns setof uuid` from `supabase.hook.teams` when no team scope has membership sources, and `authorizationProvider` from `permdock/better-supabase` fills `teamIdsOf` from it.
