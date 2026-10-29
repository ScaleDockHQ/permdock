---
"permdock": minor
---

Out-of-office covers now reach the approvers of a request's current step. `permdock rls generate` with `rls.approvals.delegations` or `rls.approvals.managers` writes a five-argument `permdock_is_approver(p_approvers, p_tenant, p_requester, p_resource, p_request_approvers)` that also checks the approvals block step's `users`, `manager` and `permission`, and `authorizationProvider({ requestApprovers: true })` passes better-supabase's `{approvers}` to it for every kind. Set it only with a better-supabase release that fills `{approvers}`. With `managers` and `delegations`, a cover now passes a `manager()` leaf when the delegator manages the requester; before, a cover never passed one. `rls.approvals: { store: false, delegations: true }` writes the covers and approver checks without the approval store.

`blockApprovalStore(approvals, { tenantless })` files a request without a tenant tenantless and reads those requests, and `resolve` now calls the block's `approve` or `reject` with `decidedBy` instead of throwing, so `approvalsHandler` works over the block. `blockApprovalPolicySource(approvals, { platform, permissions, effects })` reads platform policies, turns `conditions` into a `check` (before, a conditional policy applied to every call), matches `*` subject types and actions through an effect or the permission tree (before, such a policy applied to nothing), and takes `required: "all"` over users. `BlockApprovalTenantPolicy.organizationId` is `string | null` and a step's `required` is `number | "all"`, as in better-supabase 0.41.

Rerun `permdock rls generate` and migrate: `permdock_cover_approves` takes the requester as a fourth argument, and `permdock_manages` calls the new `permdock_manages_for`.
