---
"permdock": minor
---

`protectServer` from `permdock/mcp` accepts an MCP Apps `ui://` view registered without a `permission`: the view takes the permission of the tool whose `_meta.ui.resourceUri` names it, for `resources/list` and `resources/read`, and a view no tool links is hidden and refused. `McpUiResourceConfig` types it.
