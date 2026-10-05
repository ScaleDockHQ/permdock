---
"permdock": minor
---

`createPermDock` now passes `RoleSource.rolesFor(tenant, { held })` the role names the subject's live memberships hold in that tenant, nested scopes included. A source whose custom roles live in a database can return `[]` without reading when every held name is a declared role. The parameter is optional in the type, so existing sources and direct callers keep working.
