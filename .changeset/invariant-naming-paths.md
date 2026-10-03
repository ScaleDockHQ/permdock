---
"permdock": patch
---

A dotted condition field, relation or identifier with a `__proto__`, `constructor` or `prototype` segment (`a.__proto__`) is now rejected at definition time like the bare key, as the threat model states. `permdock/testing` renames the `ClientStoreDock` type to `ClientStorePermDock`.
