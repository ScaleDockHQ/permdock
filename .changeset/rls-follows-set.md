---
"permdock": minor
---

`rls.tables.<resource>.follows` policies always match the foreign key against one set of parent rows read once per statement, never `exists (… can_<resource>(p, …))` per child row: a permission held through root-scope roles reads `permitted_<resource>_rows(p, t)` over the caller's tenants, a global role adds `permitted_<resource>_rows(p)` only for a caller who holds one of its grant keys, and any other grantee reads `permitted_<resource>_rows(p)`. Run `permdock generate --only rls` to rewrite the `follows` part; no data migration is needed.
