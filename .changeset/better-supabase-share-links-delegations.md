---
"permdock": minor
---

better-supabase share links and approval covers, both needing better-supabase 0.9.0. The `better-supabase` peer range is now `>=0.6.0 <0.10.0`.

- `subjectFromShareLink(token, { shareLinks, links })` in `permdock/better-supabase` resolves a better-supabase share-link token into a link subject for `exchangeCapability`, so guest pages read under RLS. The link's `expiresAt` caps the capability, and a `maxLifetime` in the link policy fails closed for a share link without one.
- `rls.approvals: { delegations: true }` generates the `approval_delegations` table with owner-only policies, and a four-argument `permdock_is_approver(approvers, tenant, requester, resource)` that also passes for an active, one-hop cover. `rls.approvals.table` is now optional: without it, only the delegations are generated.
- `authorizationProvider` passes better-supabase's `{requester}` to the four-argument helper when the manifest lists it.
- `tableApprovalDelegationSource({ query })` in `permdock/supabase` reads the same table for `approvalsHandler`.

When both are installed, PermDock owns approval delegation: don't also configure better-supabase's `delegate_approval`.
