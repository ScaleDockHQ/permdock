---
"permdock": minor
---

`permdock/cloud` adds `cloudOAuth({ clientId, redirectUri })`, an OAuth client of the PermDock Cloud platform issuer with `authorizeUrl`, `exchangeCode`, `refresh` and a typed `listProjects`. It throws `CloudAuthError`, whose `code` tells `invalid-token` from `insufficient-scope` by the RFC 6750 `WWW-Authenticate` challenge. `CLOUD_BASE_URL` exports `https://permdock.com/api`. `cloud()` and `cloudEndpoints()` now default `url` to it instead of throwing without one, so a missing key is the only setup error (`cloud() requires a key`).

`cloud-api-v1.json` documents the `invalid_token` and `insufficient_scope` challenges on the projects read API, the `cursor` query of `GET /v1/projects` and `GET /openapi.json`; `testCloudApi` checks all three, and the `insufficient_scope` check runs when `platform.projectsOnly` names a token with `projects:read` only.
