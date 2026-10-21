import { workflowSdkWaiter } from "permdock/workflow-sdk";
import { createHook, sleep } from "workflow";
import { resumeHook } from "workflow/api";

import type { SendResult } from "./steps.ts";

import { openSend, send } from "./steps.ts";

const waiter = workflowSdkWaiter({ createHook, resumeHook, sleep });

/**
 * Sends one overdue invoice as the automation's publisher, parking on the
 * approval in between.
 */
export async function sendOverdue(
  ticket: string,
  invoiceId: string,
): Promise<SendResult> {
  "use workflow";
  const token = await openSend(ticket, invoiceId);
  if (token !== null) {
    await waiter.wait(token);
  }
  return send(ticket, token, invoiceId);
}
