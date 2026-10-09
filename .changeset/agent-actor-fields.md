---
"permdock": patch
---

The agent adapters keep every field of the `Actor` they resolve, as the HTTP adapters do. Before, `permdock/ai-sdk`, `permdock/claude-agent`, `permdock/eve`, `permdock/openai`, `permdock/mcp` and `permdock/a2a` kept only `id` and `kind`. An `actor` option that returned `readOnly: true` therefore lost its read-only narrowing, and the `client` name `permdock/mcp` reads from `clients` never matched a `to: { kind, client }` delegation.
