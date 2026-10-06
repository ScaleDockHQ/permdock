---
"permdock": minor
---

`composeToolApproval(app)` in `permdock/ai-sdk` now returns the application's answer as is. Before, an `undefined` answer became `'approved'`; now it stays `undefined`, which the AI SDK reads as not applicable, so the tool's own `needsApproval` or the SDK default decides. An answer that is not a tool approval result denies instead of passing. Breaking for an app whose approval function returns `undefined` to mean approved: return `'approved'` instead.
