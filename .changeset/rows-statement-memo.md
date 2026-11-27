---
"permdock": minor
---

`permitted_<resource>_rows` reads each permission in its own statement, leads an allow with `requires` by the tenants where the caller holds that key, walks the closure through its `(resource, ancestor)` index, and stores no ids in a setting; the scope, member and relation helpers and their per-statement memo are unchanged from 0.35.1. Doctor PD139 warns when a memoized helper reads a relation the memo triggers cannot watch, and `rls generate` warns for a closure over ids whose text form is not canonical, such as `numeric` or `citext`.
