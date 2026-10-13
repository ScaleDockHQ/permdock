---
"permdock": minor
---

`permdock/openai`, `permdock/claude-agent` and `permdock/eve` take `unmapped`, `context`, `otel`, `wrap` and `deniedText` as `permdock/ai-sdk` does, and `permdock/ai-sdk` takes `otel`; `operations` accepts the map `defineOperations` returns. `permdock/mcp` takes `actor` and `delegation`, which replace the actor and delegation built from the verified `authInfo`.
