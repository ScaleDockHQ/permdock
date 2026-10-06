---
"permdock": patch
---

`permdock doctor` PD014 now reads only the options of PermDock calls: object literals passed to a function imported from a `permdock` entry, the object literals nested in them, and a `const` object such a call names. An object with a `jwks` key that never reaches PermDock, such as another library's environment object, is no longer reported. Within PermDock options, `discovery` next to `issuer` is now reported as the docs describe, as `discovery` next to `jwks` already was.
