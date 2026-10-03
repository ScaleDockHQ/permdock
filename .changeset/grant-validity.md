---
"permdock": patch
---

Grants take `validFrom` and `validUntil` (RFC 3339 or Unix seconds), normalised to `Grant.validity` `{ from?, until? }`. Outside the window an allow denies with the new `inactive-grant` reason and `detail: { from, until }`; a deny does not apply and `explain` records it as skipped with `why: 'validity'`. `where()` and `filter` drop inactive grants, snapshot grants carry `validity` for the client evaluator, `permdock rls generate` ANDs `now() >= to_timestamp(from) and now() < to_timestamp(until)` into the access check, and `simulate(checks, { now })` previews a batch as of one instant. The window is part of the policy fingerprint, and the catalog marks such a permission `rowConditions: true`.
