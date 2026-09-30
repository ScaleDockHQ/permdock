---
'permdock': patch
---

`simulate()` no longer throws on an Arazzo step whose `parameters` array holds `null` or a non-object. It skips those items and decides the step as usual.
