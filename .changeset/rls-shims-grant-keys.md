---
"permdock": patch
---

`rls generate --shims` wrappers answer permissions whose grants are split by condition. A wrapper used to pass the permission key to the helpers, which take grant keys, so a permission seeded as `quote.read#1` and `quote.read#2` answered nothing. Each wrapper now carries, per helper scope, the grant keys of every permission: it answers from the keys of the unconditional allows, minus the instances where the caller holds a deny key. A conditional allow answers nothing through a wrapper, since a wrapper cannot apply a row condition; before, a permission whose grants all shared one condition answered as if they had none. The wrappers are now `security definer` (still `search_path = ''`, reading no table), so a caller needs `execute` on the wrapper only, not `usage` on the helper schema.
