# `@permdock/example-chat-sdk`

A Slack bot on the Chat SDK with `permdock/chat` and `permdock/chat-sdk`. `@acme-billing show inv_42` runs as the Slack user's linked principal. `@acme-billing pay inv_42` opens an approval request and sends an approval card to the other billing users. A click on Approve or Reject is applied as the clicking user, never as the requester.

```ts
import { createPermDock } from "permdock/chat";
import {
  approvalActions,
  chatSdkAuthor,
  chatSdkTransport,
} from "permdock/chat-sdk";
```

```bash
SLACK_BOT_TOKEN=xoxb-... SLACK_SIGNING_SECRET=... pnpm start
```

Point the Slack app's event and interactivity URLs at `/api/webhooks/slack` on port 3498. A Slack user with no identity link in `src/policy.ts` is anonymous and denied.
