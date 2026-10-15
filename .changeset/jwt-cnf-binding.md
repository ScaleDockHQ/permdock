---
"permdock": minor
---

`subjectFromJwt` no longer accepts a sender-constrained token as a bearer token. Without `sender`, a token whose `cnf` carries `jkt` needs a valid DPoP proof, and one whose `cnf` carries `x5t#S256` needs a matching `certificateThumbprint`. An explicit `sender: "none"` keeps the old behaviour for a gateway that verified the binding upstream.
