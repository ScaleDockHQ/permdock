---
"permdock": minor
---

`defineOperations` binds named actions to permissions with typed `data`, a `results` filter and `meta`, and `permdock collect` writes them to the catalog as `operations` (doctor PD067). `PrincipalSource` with `memoryPrincipalSource` and `testPrincipalSource` loads principals by id or identity link. `permdock.decideEach` decides a list of rows in order, and `permdock.decideFor` decides for another principal from the new `principals` option without widening the caller or consuming a limit. A `kind: 'contact'` principal keeps only its `on` memberships, reads by default and writes only through a role with `for: ['contact']`; it never approves or creates keys.
