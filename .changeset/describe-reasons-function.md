---
"permdock": minor
---

`describe(decision, { messages })` accepts `messages.reasons` as a function `(reason, decision) => string | undefined` as well as a record, so a translation layer can read the denied decision. `undefined` keeps the reason code.
