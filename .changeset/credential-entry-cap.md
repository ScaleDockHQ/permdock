---
"permdock": patch
---

A credential may list any number of permissions. `parseCredential` and `decideCredential` no longer cap `permissions` at 64 entries, so a verified key that delegates a read-and-write set over a catalog of 100 or more permissions resolves through `subjectFromApiKey` instead of failing as `invalid-claims` and becoming anonymous. The cap guarded self-contained tokens; a credential always comes from the application's own store through a verifier. `ids` per entry keeps its limit of 64.
