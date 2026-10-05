---
"permdock": minor
---

`countHolders(memberships, { scope, id, role })` counts the principals holding a role in one scope instance from the `MembershipSource`'s `list`, live memberships only and each principal once, for the `holders` that `decideRoleChange` needs with `min`, `max` or `transferOnly`. It answers `undefined` when the source cannot list or the read fails, which the role change check denies.
