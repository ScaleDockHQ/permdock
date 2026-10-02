---
'permdock': patch
---

`permdock.explain(permission, data)` (or `decide` with `explain: true`) returns the decision with a `trace`: how many grants were evaluated, the allows and denies that matched (`trace.denies[0]` is the deny that won) and the grants skipped with the reason. `MatchedGrant` carries the grant's `name`; a `deny` denial from a named deny carries `detail: { name }`. `describePolicy` cells take `deniedBy`. The trace is off by default and never emitted on a decision event.
