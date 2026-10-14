# `@permdock/example-resend`

Email delivery through `permdock/delivery` and `permdock/resend`. `src/send.ts` sends an invoice notice to a member, a client contact and an unknown address, then an approval prompt to the other billing user. `src/webhook.ts` turns Resend webhooks into `delivery` events.

```ts
import { createPermDock } from "permdock/delivery";
import { approvalEmail, resendTransport, resendWebhook } from "permdock/resend";
```

```bash
pnpm send
RESEND_API_KEY=re_... pnpm send
RESEND_WEBHOOK_SECRET=whsec_... pnpm start
```

Without `RESEND_API_KEY`, `pnpm send` uses `memoryDeliveryTransport` and sends nothing. The unknown address fails with `unlinked`; the approval email links to the approval page and approves nothing.
