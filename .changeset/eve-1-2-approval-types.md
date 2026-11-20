---
"permdock": minor
---

BREAKING: `permdock/eve` needs eve 1.2.0 or later, and the `ai` and `chat` peers need 7.0.177 and 4.45.0. `EveResponseContext` takes `request.interactionId` and `request.principal` in place of `request.requestId`, the decision is `"approve" | "deny"` with no `cancel`, and the session has `turn` and an optional `parent`. A response on another instance now recomputes the approval token with `request.principal` as the caller.
