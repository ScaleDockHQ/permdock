---
"permdock": patch
---

Denials that leave the process are now `WireDenial` (`{ role, reason, to?, detail? }`), and `DecisionEvent.denials` and `ProblemDetails.denials` are typed that way. This covers decision events, Problem Details bodies, MCP and WebMCP refusals and the decision endpoint. `detail` is kept only as a JSON value: what a closure threw (`closure-error`), a validation error and any `Error` or non-JSON detail are dropped, so they no longer reach a sink or a response body. `WireDenial` and `WireDecision` are exported from `permdock`.
