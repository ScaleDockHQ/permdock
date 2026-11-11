---
"permdock": patch
---

`permdock supabase inspect` lists `permdock_approver_for_ids` and `permdock_managed_user_ids` in `permdock.manifest.json`, so `authorizationProvider` fills `approverFor` and `managedUsers` from a generated manifest. A `rls.approvals.managers` table without a `tenant` column leaves `managedUsers` unset, because better-supabase calls it with `{tenant}`.
