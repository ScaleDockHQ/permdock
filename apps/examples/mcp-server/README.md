# `@permdock/example-mcp-server`

`protectServer` around a duck-typed MCP server. `pnpm start` loads the tools over stdio (no HTTP port).

- `update_post` — granted for a member on their own post
- `delete_post` — `approval-required`

`/rpc/mcp` serves `src/procedures.ts`: oRPC procedures exposed as MCP tools with `protectServer(server, { enforce: 'procedure', permissionFor })`. `permissionOf(procedure)` from `permdock/orpc` names each tool's permission for `tools/list`, and the procedure's `protect` makes the one decision per call.

```ts
import { createPermDock } from "permdock/mcp";
```
