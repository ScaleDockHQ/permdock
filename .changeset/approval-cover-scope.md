---
"permdock": minor
---

`permdock_request_approver_ids` and `permdock_approver_for_ids` follow a cover's `tenant`, `resources` and `permissions`, so a cover limited to one kind of request, one tenant or some permissions no longer makes the delegate an approver of every request. `permdock_request_approver_ids` takes an optional `p_resource`, and `authorizationProvider` passes the request kind's resource to it; rerun `permdock rls generate` and `permdock supabase inspect --out`.
