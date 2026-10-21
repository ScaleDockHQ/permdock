---
"permdock": minor
---

`permdock/mcp` adds `mcpResourceGuard`, which verifies the bearer token for an MCP resource and answers `McpAuthInfo` or a `401` / `403` response with an RFC 9728 challenge, and `protectedResourceMetadata`, which serves the RFC 9728 document.
