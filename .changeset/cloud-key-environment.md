---
"permdock": minor
---

Breaking default: `permdock/cloud` and `permdock cloud push` no longer read `VERCEL_ENV` or fall back to `production`. The environment is `environment` (or `--project`), then `PERMDOCK_CLOUD_ENV`, then the one the new `GET /v1/environment` route names for the key. Without a configured environment, `cloud().issuer` and `cloud().jwks` are unset until `cloud().endpoints()` resolves, `cloudEndpoints()` throws, and `resolveCloudEndpoints()` asks the Cloud. `cloud({ verifier })` also accepts `(endpoints) => TokenVerifier`. Set `PERMDOCK_CLOUD_ENV` to keep the old name-based resolution.
