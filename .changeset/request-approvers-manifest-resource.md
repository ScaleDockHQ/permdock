---
"permdock": patch
---

`permdock supabase inspect` lists `p_resource` on `permdock_request_approver_ids` when delegations are on, so `authorizationProvider` requires the function with its real signature and passes the request kind's resource to it, and it lists `pg_catalog.split_part` among the functions the template calls.
