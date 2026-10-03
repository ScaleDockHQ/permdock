---
"permdock": patch
---

Provisioned roles and plans are bound to their tenant. `directoryMembershipSource` looks users up with a structured `eq` filter, so a principal id is never parsed as filter syntax. Core drops roles the policy declares `assignable: false` from `managedBy: 'idp'` memberships, and `scimHandler` reports unknown roles on `PATCH` too. `subjectFromClerk` puts `o:` plans (as `entitlements`) and `o:` features on the session organization's membership instead of the principal.
