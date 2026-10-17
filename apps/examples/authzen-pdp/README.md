# `@permdock/example-authzen-pdp`

Both halves of AuthZEN: the PermDock PDP that `permdockHandler()` serves, and a PEP that delegates to it with `remotePdp`.

- `src/server.ts`: the PDP. `pnpm start` serves it on `127.0.0.1:3470` with `GET /health`. `POST /access/v1/evaluation` with `Authorization: Bearer test` grants `post.update` on the member's own post and denies `post.publish`. The `Bearer pep` caller is the one trusted PEP: only it may name the subject in the body.
- `src/pep.ts`: the PEP. Every post permission goes to the PDP; the local roles still have to grant too.
- `src/pep-cloud.ts`: the same PEP against the hosted ADS at `<PERMDOCK_CLOUD_URL>/v1/environments/<env>`, authenticated with OAuth client credentials.
- `tests/parity.test.ts`: the policy matrix through `describePolicy`, then every cell through the PEP and the local PDP. With the `PERMDOCK_CLOUD_*` variables in `.env.example` set in the environment, every cell also runs through the hosted ADS, and `testCloudApi` checks the environment's HTTP API.

```ts
import { createPermDock } from "permdock/authzen";
import { remotePdp } from "permdock/pdp";
```

Publish the policy to the environment with `permdock cloud push` before the Cloud run, and register the OAuth client under `/trusted-peps`.
