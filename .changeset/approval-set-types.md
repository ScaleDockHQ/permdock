---
"permdock": minor
---

Breaking: `permdock_approver_for_ids()` and `permdock_managed_user_ids(p_tenant)` return `setof uuid` on Supabase and `setof text` elsewhere, and cast no column. `rls.approvals.managers.tenant` names the column of the manager table that holds each edge's tenant. It is required when the policy has a tenant scope, otherwise `generate` fails with `config_invalid`. `permdock_managed_user_ids`, `permdock_manages_for` and `permdock_manages` keep only the edges of the request's tenant, so a manager in one organisation no longer reaches reports in another. The better-supabase provider template is `permdock_managed_user_ids({tenant})`.
