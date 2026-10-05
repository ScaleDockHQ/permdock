---
"permdock": minor
---

Every `customRoles` option, on `createPermDock` and on each adapter (`permdock/server`, `permdock/mcp`, `permdock/next`, the agent adapters and the rest), also takes a `RoleSourceFactory`, `(subject) => RoleSource | undefined`, called once per instance with the resolved subject. A source that reads one principal's roles no longer has to remember the last principal an adapter served; a factory that throws reads no custom roles and reports `source-threw`. `RoleSourceFactory` is exported from `permdock`.
