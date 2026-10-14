import type { DecisionSink } from "permdock";

import { createServer } from "node:http";
import { sendResponse, toRequest } from "permdock/node";
import { resendWebhook } from "permdock/resend";
import { memoryReplayStore } from "permdock/server";
import { Resend } from "resend";

const secret = process.env["RESEND_WEBHOOK_SECRET"] ?? "";
if (secret === "") {
  throw new Error("Set RESEND_WEBHOOK_SECRET to the webhook's signing secret");
}

const sink: DecisionSink = {
  write(events) {
    for (const event of events) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
  },
};

const handle = resendWebhook({
  resend: new Resend(process.env["RESEND_API_KEY"] ?? "re_unused"),
  secret,
  sink,
  replay: memoryReplayStore(),
});

const port = Number(process.env["PORT"] ?? 3497);
const host = "127.0.0.1";

createServer((req, res) => {
  const respond = async (): Promise<void> => {
    await sendResponse(res, await handle(toRequest(req)));
  };
  respond().catch(() => {
    res.statusCode = 500;
    res.end();
  });
}).listen(port, host);
