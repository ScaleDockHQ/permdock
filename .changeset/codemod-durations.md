---
"permdock": patch
---

`permdock codemod 0.5` turns duration strings such as `ttl: "30m"`, `escalation.after`, `limit.per`, `maxDuration`, `duration` and `consent.durations` into whole seconds inside a call to a PermDock import, and lists the same keys elsewhere as manual follow-ups.
