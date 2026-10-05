---
"permdock": minor
---

`permdock/a2a` and `permdock/mcp` now decide through the shared agent kernel. An A2A task failure's `status` follows the Problem Details matrix: `401` with a `wwwAuthenticate` challenge for an anonymous caller, `429` and `503` for limits, `403` otherwise. `permdock/terminal` `protect` exits with `EX_NOPERM` when `load` throws or returns nothing for an instance permission. `permdock/convex` accepts the instance options (`memberships`, `sink`, `limits` and the rest). `permdock/testing` adds `testAgentAdapter`.
