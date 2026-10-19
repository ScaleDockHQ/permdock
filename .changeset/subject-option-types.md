---
"permdock": patch
---

The `subject` option of `createPermDock` in `permdock/next`, the HTTP adapters and the agent adapters now types a full `Subject` as a valid return, as it already worked at runtime, so `subject: () => subjectFromClerk(await auth())` compiles against an app whose policy has a typed `User`.
