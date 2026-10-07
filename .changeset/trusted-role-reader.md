---
"permdock": minor
---

`permdock rls generate` writes `permdock_trusted_role_permissions(p_role, p_scope, p_tenant, p_scope_id)` next to the member-facing `permdock_role_permissions`: the same rows and argument checks without the caller check, for server code such as an admin backend, a support console or a job. No client role may execute it, and the new `rls.trustedReaders` lists the Postgres roles it is granted to, such as `['service_role', 'support_reader']`.
