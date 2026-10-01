---
'permdock': patch
---

`permdock supabase inspect --out` with no path writes `permdock.manifest.json`, and `inspect --check` without `--out` checks that file instead of exiting 2. The `datetime_preferences` claim in `supabaseClaimFixtures.full` now uses CentraKit's keys: `timezone`, `week_start`, `date_format` and `time_format`.
