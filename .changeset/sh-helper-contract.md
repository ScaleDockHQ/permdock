---
'permdock': minor
---

The SQL helpers have a written contract: `permdock_has`, `permitted_<scope>_ids` and `permitted_<resource>_ids`, what each answers, the grant keys to pass, the role-and-scope-only rule and the exact-text id rule, on the RLS page. `schemas/supabase-claims-v1.json` in the package is the JSON Schema of the claims the hook writes and the helpers and `subjectFromSupabase` read. The Supabase page adds a "With better-supabase" split of what each package owns.
