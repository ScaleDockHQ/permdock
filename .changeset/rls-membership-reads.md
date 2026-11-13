---
"permdock": patch
---

`permitted_<scope>_ids_by_permission` and its `_for` forms read the caller's memberships once per call instead of once per grant key, for policies without custom roles. Rerun `permdock generate` to pick it up.
