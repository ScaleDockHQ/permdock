---
"permdock": minor
---

A bootstrap subject read for one tenant is now seeded under that tenant instead of as the user's all-tenants record, so a check in another tenant no longer misses that tenant's memberships. `postgrestSources({ tenantScoped: true })` also answers `memberships.globalRolesFor` from the tenant's record, so a stale token's reread costs one `subject_for` call, and `globalRolesFor` receives the instance's `tenant` in its context. Pair a tenant bootstrap with `tenantScoped: true` to keep reading no `subject_for` on a seeded request.
