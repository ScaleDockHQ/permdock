---
"permdock": minor
---

`permdock.canAll(checks)` and `permdock.decideAll(checks)` check several permissions on one instance, where a check is a permission or a `[permission, row]` pair; `canAll([])` is `false`. `isRoleName(policy, value)` narrows a role string to the policy's declared roles (`RoleNameOf<typeof policy>`). `allow` and `deny` also take a resource, a list of resources or the whole tree without a condition, so `role("owner", [allow(permissions)])` grants every action.
