---
"permdock": minor
---

`permdock/ai-sdk` takes `unmapped: 'deny' | 'allow'` and returns `composeToolApproval(app)`. With `'allow'`, tools the `tools` map does not bind to a permission stay in `capabilityMiddleware`'s list and pass `toolApproval`; the default `'deny'` keeps hiding and denying them. `composeToolApproval(app)` runs PermDock's verdict first and asks the application's own approval function only for a call PermDock grants, so apps no longer wrap the adapter to compose a registry's confirmation. It returns the application's answer as is: `undefined` leaves the decision to the tool's own `needsApproval` or the SDK default, and an answer that is not a tool approval result denies.
