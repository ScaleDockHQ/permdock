---
"permdock": minor
---

`subjectFromJwt` and `jwtSubjectResolver` require `audience` when no `verifier` is passed. Without it, a token minted for another resource server at the same issuer was accepted. Pass `audience: false` to accept any audience on purpose.

| Before                                 | After                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `subjectFromJwt(token, { discovery })` | `subjectFromJwt(token, { discovery, audience: "https://api.example.com" })` |
| no audience check                      | `audience: false`                                                           |
