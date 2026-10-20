---
"permdock": minor
---

`subject_for` now returns a `claims` object with `team_ids` and each `supabase.hook.claims` entry, and `postgrestSources().subject()` and `.refresh()` put them on `principal.claims`, so a stale-token reread keeps team-scoped levels. Re-run `permdock supabase hook generate`.
