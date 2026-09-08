# `@permdock/example-mcp-server`

Minimal `permdock/mcp` wiring: `protectServer` around a duck-typed MCP server, `list_posts` / `update_post` / `delete_post` with typed permissions. Host the same `registerTool` calls through `mcp-handler` when you add a transport.

```ts
import { createPermDock } from 'permdock/mcp'
```
