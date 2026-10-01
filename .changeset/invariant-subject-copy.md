---
'permdock': patch
---

`createPermDock` freezes a copy of the subject instead of the caller's user object, roles and context, so later writes to them neither throw nor reach the instance. A schema that returns a rejecting Promise at a boundary, in a claims mapping or in WebMCP tool arguments no longer leaves an unhandled rejection behind.
