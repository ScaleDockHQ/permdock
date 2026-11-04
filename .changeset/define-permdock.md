---
"permdock": minor
---

Add the `permdock/app` entry with `definePermDock`, which replaces `defineApp` and adds `getPermDock`, `fromClaims`, `fromApiKey`, `sources` and `evict` to the policy it returns. `permdockFor`, `authorizer`, `authorizationHooks`, `supportPolicy`, `subscriberPolicy` and `postgrestSources` read `memberships`, `instances`, `versions` and `subjects` from the definition. Breaking: change `import { defineApp } from "permdock"` to `import { definePermDock } from "permdock/app"`; `permdock codemod 0.5` lists each import.

| Old                                          | New                                                   |
| -------------------------------------------- | ----------------------------------------------------- |
| `defineApp(policy, options)` from `permdock` | `definePermDock(policy, options)` from `permdock/app` |
