---
"permdock": minor
---

`rls.tables.<resource>.follows` writes select, insert, update and delete policies on each child table. They call `can_<resource>` on the parent row. `also` names resources that share the table and get no policies of their own. `walk: "recursive"` writes `permdock_<resource>_chain()`, and with `rls.approvals.delegations` the chain also starts from an active cover.
