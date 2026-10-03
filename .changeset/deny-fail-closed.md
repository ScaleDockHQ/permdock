---
"permdock": patch
---

A deny that cannot be evaluated now denies the decision, as a relation deny already did: a deny closure that throws or returns a thenable (`closure-error`) and a deny with an opaque condition (`opaque-condition`). An opaque node nested under `not`, `or` or `and` now fails its grant with `opaque-condition` on the server and in `fromSnapshot`, so `not(opaque)` no longer matches. `coveredByDelegation` treats an RFC 9396 or GNAP entry whose `identifier` is not a string or whose `actions` is not an array as covering nothing, instead of ignoring the field.
