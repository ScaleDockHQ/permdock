---
"permdock": patch
---

`subjectFromClerk` reads the `globalRoles` claim path through the shared path reader, so a `__proto__`, `constructor` or `prototype` segment yields no roles.
