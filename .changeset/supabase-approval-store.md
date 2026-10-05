---
"permdock": minor
---

`rls.approvals: true` makes `rls generate` add an approval store to the helpers: an `approval_requests` table and one `security definer` function per `ApprovalStore` method (`permdock_approval_open`, `_get`, `_resolve`, `_consume`, `_list`, `_expire`, `_cancel`), each one atomic statement and closed to client roles. `supabaseApprovalStore(client, { schema?, ttl?, onOpen? })` in `permdock/supabase` implements `ApprovalStore` over them through supabase-js and passes `testApprovalStore`; `onOpen` runs after a request is stored, for notifications and superseding older requests. `APPROVAL_POLICY_UNAVAILABLE` is exported for the detail of a denial caused by a failing `ApprovalPolicySource`.
