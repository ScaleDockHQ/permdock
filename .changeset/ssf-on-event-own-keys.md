---
'permdock': patch
---

The SSF receiver looks up `onEvent` handlers by own key only. An event named after an `Object.prototype` member, such as `toString`, now reaches the `*` handler instead of calling the inherited function.
