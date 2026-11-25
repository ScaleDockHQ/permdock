---
"permdock": minor
---

Breaking: the hook writes `memberships` as `{ s, r, v, e, o }`, with 22 character ids and role indexes, so the 1,024-byte budget keeps 25 CentraKit memberships instead of 9. `readMemberships`, `subjectFromSupabase` and the `jwt`-mode `authorize` read both forms; code that reads the raw claim as an array uses `expandMemberships` from `permdock/supabase`. `permdock claims size` reports the compact fit.
