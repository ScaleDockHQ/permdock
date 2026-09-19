---
'permdock': minor
'@permdock/testing': patch
---

Add a `membership` sink event (`dev.permdock.membership`) and `membershipEvent()` so in-app role changes are auditable. SCIM group membership writes and Better Auth `onRoleChange({ sink })` emit it (ADR 0048).
