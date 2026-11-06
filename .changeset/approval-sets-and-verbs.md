---
"permdock": minor
---

Breaking: a verb that does not infer and has no `rls.actions` entry is `config_invalid`. The error names the verbs that infer. `rls.approvals` writes `permdock_approver_for_ids()` (the caller plus active delegators, one hop) and, with `managers`, `permdock_managed_user_ids()`, which walks down and leaves the caller out.
