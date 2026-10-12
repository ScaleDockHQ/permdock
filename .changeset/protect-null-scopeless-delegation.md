---
"permdock": patch
---

`protect(null)` in `permdock/server` now refuses a delegated token (one with an actor or a delegation) that carries no scopes, with the `403` `insufficient_scope` challenge. It passed before, while `permdock/mcp` refused the same token. First-party sessions are unchanged.
