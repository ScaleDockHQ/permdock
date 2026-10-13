---
"permdock": minor
---

`permdock/agent` adds `createPermDock`, which returns the agent contract the AI SDK, OpenAI Agents, Claude Agent SDK and Eve adapters now share: `decideOperation`, `allowedOperations`, `decideModel` and `permittedModels` over a new `models` option, `filterResults` by an operation's `results` permission, and `gatewayOptions` for AI Gateway attribution. `testAgentRuntime` from `permdock/testing` runs that contract against any implementation.
