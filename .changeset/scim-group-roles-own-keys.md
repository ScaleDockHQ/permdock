---
'permdock': patch
---

`scimHandler` and `directoryMembershipSource` read `groupRoles` by own key only. A group id such as `constructor` or `__proto__` no longer resolves to an `Object.prototype` member, which made the SCIM endpoint answer 500.
