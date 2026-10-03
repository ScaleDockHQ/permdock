---
"permdock": patch
---

`permdock/testing/saas` adds scenarios for an agent acting without a delegation, a delegation narrower than the user's grants, an exhausted api-key quota, a team role held on the tenant membership, `org-1` against `tenant-1` on lists and writes, and an expired membership on every permission class. Scenarios may carry `actor`, `delegation` and `quotaUsed`; `saasUser`, `saasScenarioOptions` and `saasLimitStore` build the subject and options a case runs with.
