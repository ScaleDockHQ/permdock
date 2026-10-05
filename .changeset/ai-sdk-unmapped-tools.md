---
"permdock": minor
---

`permdock/ai-sdk` takes `unmapped: 'deny' | 'allow'` and returns `composeToolApproval(app)`. With `'allow'`, tools the `tools` map does not bind to a permission stay in `capabilityMiddleware`'s list and pass `toolApproval`; the default `'deny'` keeps hiding and denying them. `composeToolApproval(app)` runs PermDock's verdict first and asks the application's own approval function only for a call PermDock grants, returning its answer (`undefined` is approved), so apps no longer wrap the adapter to compose a registry's confirmation.
