---
"permdock": minor
---

`defineApp(policy, options)` binds an app's sources, features and services (`memberships`, `customRoles`, `relations`, `entitlements`, `principals`, `settings`, `policies`, `approvalPolicies`, `limits`, `sink`, `store`) to a policy. Core `getPermDock` and every adapter read them, and an adapter's own options win key by key. `profile: "dev"` fills in a memory limit store and a memory approval store; `profile: "prod"` (the default) throws at startup when a grant needs a store or limits the app does not configure.

`permdock/eve` and `permdock/openai` no longer fall back to a memory approval store on their own: pass `store`, or use `defineApp` with `profile: "dev"`.
