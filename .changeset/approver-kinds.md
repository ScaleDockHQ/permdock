---
"permdock": minor
---

Approvals gain `holder(permission)`, an approver who holds the permission in the request's tenant through any role (custom roles included), checked through `verdict.permissions` that `approvalsHandler` reads with the new `permdockFor` option and `approverPermissions`. `anyOf(...)` lets any one of several approvers sign (a list, or `allOf(...)`, stays all-of). A stage can carry its own `escalation`, and an `ApprovalPolicy` entry may now set `escalation`, which widens only that entry's stages.
