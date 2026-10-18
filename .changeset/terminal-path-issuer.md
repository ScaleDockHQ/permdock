---
"permdock": patch
---

`permdock/terminal` finds the RFC 8414 metadata of an issuer with a path at the path-inserted URL (`https://permdock.com/.well-known/oauth-authorization-server/api` for `https://permdock.com/api`), then at the appended one, and refuses metadata whose `issuer` differs from `device.issuer`. A token response's `scope` is stored with the credential.
