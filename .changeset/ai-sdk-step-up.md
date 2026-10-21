---
"permdock": minor
---

`permdock/ai-sdk` takes `stepUp: { at? }`. With it, `toolApproval` answers an `insufficient-user-authentication` denial, or a denial that an eligible role activation would lift, with `{ type: 'user-approval', reason, stepUp }`, and its re-check runs the tool only when `decide` grants it. Type change: `ToolApprovalStatus` gains this `user-approval` member, which carries `stepUp` instead of `token`, so narrow with `'token' in status` before reading `token`.
