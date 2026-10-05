---
"permdock": patch
---

`rls generate` no longer invents a table for a resource that `rls.tables` does not name. With `rls.tables` set and `--helpers-only`, such a resource gets no index in the `indexes` part or the `index suggestion` warnings, and `rls verify --introspect` no longer warns about a missing index on it; `generate` names the skipped resources once. Without `--helpers-only`, its policies still target `public.<resource>`, and `generate` now warns that they do. A config without `rls.tables` keeps mapping every resource to the table of the same name.
