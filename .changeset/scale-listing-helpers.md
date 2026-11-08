---
"permdock": minor
---

`permdock.permittedScopeIds(permission, { tenant })` lists the scope instances inside one tenant where the subject holds a permission, `permdock.mayUseMany(permissions)` answers a tool list from one snapshot read, and `permdock.filterIds(permission, ids)` keeps the ids that name a scope instance the subject holds the permission on, without loading rows. None of them is a decision.
