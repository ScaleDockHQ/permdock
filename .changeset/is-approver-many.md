---
"permdock": minor
---

`authorizationProvider({ isApproverMany: true })` fills better-supabase's `isApproverMany` with `permdock_approver_request_ids({requests}, …)`, over the same kinds and `requestApprovers` as `isApprover`, so the approvals block decides every pending request in one call. It needs `permdock_approver_request_ids` in the manifest and a better-supabase release with the `isApproverMany` slot, so it is off by default.
