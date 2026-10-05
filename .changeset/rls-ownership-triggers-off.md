---
"permdock": minor
---

`rls.ownershipTriggers: false` leaves out the holder-count and transfer-only triggers that `min`, `max` and `transferOnly` put on the membership tables, and `rls.ownershipTriggers: { <scope>: false }` leaves them out for the named scopes, for an application that enforces those counts its own way. `decideRoleChange` keeps checking the rules and `permdock_can_assign` is still written.
