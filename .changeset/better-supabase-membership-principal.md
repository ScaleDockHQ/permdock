---
"permdock": minor
---

`principalFromMemberships(userId, rows, { scope?, tenant? })` in `permdock/better-supabase` builds a `Principal` from rows of the organizations block's `memberships` table, one membership per `organization_id`, and drops other users' rows and disabled rows.
