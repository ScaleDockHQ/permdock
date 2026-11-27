---
"permdock": minor
---

`permitted_<resource>_rows` reads each permission in its own statement and leads an allow with `requires` by the tenants where the caller holds that key, a closure walk now uses the `(resource, ancestor)` index, and the row sets no longer store their ids in a setting. Under `rls.memo`, the scope, member, by-permission and relation memos last for the transaction and are keyed on a hash of the whole token, so later statements of one transaction reuse them and a claims change misses.

`member_<scope>_ids()` is now `volatile` and no longer `parallel safe` under `rls.memo`. Closure walks compare ids as text, which is exact for `uuid`, integer and `text` ids; `rls generate` warns for other id types. Doctor PD139 warns when a memoized helper reads a view, a function or a table the memo triggers cannot watch.
