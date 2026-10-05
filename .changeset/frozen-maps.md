---
"permdock": patch
---

A policy's `Map` and `Set` members (`rolesByName`, `resources`, `index.grantsByKey`) now throw a `TypeError` on `set`, `add`, `delete` and `clear`, as the rest of the frozen policy does on assignment. `memoryRoleSource` returns a copy of its role list on each call.
