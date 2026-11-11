---
"permdock": minor
---

Breaking: `authorizationProvider({ personas: 'roles' })` sends `personas: 'roles'` with `fixtureRoles` instead of an expanded persona list; a tenant role's setup inserts the role id when memberships read roles through a roles table, and a global role goes into `rls.roles`. The provider also fills `functions.subjectForTenant`, `bootstrapPermissions` and `canIn`, `permissions[].levels` and `tokenHook.teamIdsTruncatedClaim`.
