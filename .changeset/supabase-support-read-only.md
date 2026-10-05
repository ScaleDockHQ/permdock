---
"permdock": patch
---

`subjectFromSupabase` and `actorOf` in `permdock/supabase` read a support `act` level without `read_only` as read-only (`Actor.readOnly: true`), as better-supabase does. Before, such a token could reach every delegated write.
