---
"permdock": patch
---

`permdock rls generate` warns when `rls.approvals.delegations` is set with `--authorize jwt`: `permdock_is_approver` cannot read a delegator's permissions from the caller's token, so a cover never satisfies a `holder()` approver in SQL.
