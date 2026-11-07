---
"permdock": minor
---

Breaking: `claimsFirst` with `onStale: 'reread'` rereads a token that names a role the policy does not declare, and keeps the actor. `subjectFromSupabase` keeps those global roles when `customRoles` is set, and a `client_id` with no `scope` or `authorization_details` stays actor-less. `useAssignablePermissions` returns `{ permissions, status }`; a local snapshot answers `status: 'server-only'`.
