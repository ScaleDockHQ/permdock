---
"permdock": minor
---

`permdock_approver_for_ids(p_tenant, p_resource)` follows the covers of one tenant and resource, next to the argument-less form, which since the cover scope fix follows only covers with no tenant, resources or permissions. Upgrade notes: a policy that relied on `permdock_approver_for_ids()` for tenant covers should call the two-argument form. `permdock_request_approver_ids` gained `p_resource`, and the generated SQL drops the old signature first, so drop or recreate a policy or view that calls `permdock_request_approver_ids(p_requester, p_tenant)` in the same migration.
