---
'permdock': patch
---

Snapshots bind `principal.claims.*` refs in grant conditions to the subject's values. The snapshot principal carries no claims, so a client read them as missing: an `eq` or `in` on a claim denied what the server granted, and a `notIn` granted what the server denied. `principal.id`, `tenant` and the other fields the snapshot carries stay references.
