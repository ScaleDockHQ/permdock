---
"permdock": minor
---

`permitted_<resource>_rows` reads each permission in its own statement and leads an allow with `requires` by the tenants where the caller holds that key, a closure walk now uses the `(resource, ancestor)` index, and the row sets no longer store their ids in a setting. Under `rls.memo`, the scope, member, by-permission and relation memos last for the transaction and are keyed on a hash of the whole token, so later statements of one transaction reuse them and a claims change misses.
