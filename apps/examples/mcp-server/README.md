# `@permdock/example-mcp-server`

`protectServer` around a duck-typed MCP server. `pnpm start` loads the tools over stdio (no HTTP port). Playwright imports the guarded handlers.

- `update_post` — granted for a member on their own post
- `delete_post` — `approval-required`

```ts
import { createPermDock } from 'permdock/mcp'
```
