---
"permdock": minor
---

Breaking: `member_team_ids_for` and `member_team_ids_of` are written by `rls generate`, and the hook calls the reader instead of the teams table. `team_ids` has its own budget: on overflow the claim is omitted and `team_ids_truncated` is set. A change to `supabase.hook.teams` bumps `authz_ver` for the old and new holder.
