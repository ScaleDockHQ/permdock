---
"permdock": patch
---

The Supabase manifest's `rls` section has a `memberships` list of the tables `member_<scope>_ids_for` reads, in the same shape as the hook's `memberships`. It names the `rls.memberships` table mapped for each scope, else the `rls.membershipSources` that can hold it, else the hook's sources. A reader that resolves memberships outside the hook, such as better-supabase's entitlements, can now read the tables the SQL helpers use.
