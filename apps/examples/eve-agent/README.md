# `@permdock/example-eve-agent`

HTTP harness for `permdock/eve`. `pnpm start` listens on `127.0.0.1:3474` with no model API key. This app is also the deploy template for the PermDock Cloud listing on the Vercel Marketplace.

- `GET /health`
- `GET /list_posts`: `approval.request` returns `not-applicable`
- `GET /delete_post`: `approval.request` returns `user-approval`, plus `inbox` with the Cloud
- `POST /approve`: answers as the admin reviewer
- `/approvals/*`: the mounted `approvalsHandler`; `Authorization: Bearer reviewer` is the demo approver
- `POST /webhooks/permdock`: the `cloudApprovalWaiter` endpoint for the environment's webhook connector, with the Cloud only

```ts
import { createPermDock } from "permdock/eve";
```

## PermDock Cloud

`src/cloud.ts` uses `cloud()` when `PERMDOCK_CLOUD_URL` and `PERMDOCK_CLOUD_KEY` are set, and `memoryApprovalStore()` otherwise. With the Cloud, approvals are stored in the environment, every decision goes to `cloud().sink`, and the resolved, expired and cancelled webhooks wake parked runs. `.env.example` lists the keys. `POST /approve` resolves in the Cloud only with `PERMDOCK_CLOUD_APPROVER_JWK` and `PERMDOCK_CLOUD_APPROVER_ISSUER` set; otherwise approve in the inbox.

With the Cloud, the agent also applies hosted grants: `post.publish` is `hostable`, so a grant written in the dashboard can extend who may publish without a deploy, and never overrides a code deny. `cloud()` verifies the environment's signed policy document against its JWK Set, `src/serve.ts` refreshes it at start and every minute, and `createPermDock` passes it as `policies: hostedPolicies(app.policies)`.

### CI

Publish the policy from the deploy job. A job that only reads, such as a pull-request check, pulls what was published and compares it with the code:

```sh
pnpm exec permdock cloud push             # deploy job: PERMDOCK_CLOUD_URL, PERMDOCK_CLOUD_KEY
pnpm exec permdock cloud pull --project "$PERMDOCK_CLOUD_PROJECT"   # PERMDOCK_CLOUD_TOKEN
pnpm exec permdock collect --check        # exit 1 when the published catalog differs from the code
```

`PERMDOCK_CLOUD_TOKEN` is the read-only CI key from the project settings. It reads one environment and cannot push, so it can sit in pull-request jobs; never deploy it with the app. `cloud pull` writes `permissions.catalog.json` as `permdock collect` writes it, and `collect --check` ignores `generatedAt`, so the check passes while the published policy matches the code.
