---
"permdock": patch
---

`permitted_<resource>_rows(p_permission)` states each permission's arm in the set query for closure and link-walk resources, so its sub-selects run once per statement instead of once per row through `permitted_<resource>_match`. A 5,500-row `file_nodes` folder page that took 57 s now takes tens of milliseconds. `permdock doctor` PD103 reports a policy that calls a `permitted_<resource>_rows('key')` from an older release, whose body has no arm for the key. Regenerate with `permdock rls generate`.
