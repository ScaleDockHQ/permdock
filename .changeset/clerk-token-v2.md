---
'permdock': patch
---

`subjectFromClerk` reads Clerk session token v2. It maps the compact `o` claim to `tenant`, `org:<rol>` and permission keys rebuilt from `fea` and `fpm`, and a v2 payload with only `o` now counts as a verified payload. `memberships: 'all'` now pages through `getOrganizationMembershipList` 100 rows at a time, where before it read Clerk's first page of 10, and drops rows whose `publicUserData.userId` is another user's.
