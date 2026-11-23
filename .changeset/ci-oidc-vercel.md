---
"permdock": minor
---

`subjectFromCiOidc` takes `provider: 'vercel'`, which verifies a Vercel OIDC token against `https://oidc.vercel.com` (or a team `issuer`) and returns a `workload` principal with the team id as `owner`, the project id as `project` and `environment`.
