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
