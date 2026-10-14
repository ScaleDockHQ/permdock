import type { Decision } from "permdock";

import { invoices, permissions } from "../permissions.ts";
import { runs } from "../runs.ts";

export type SendResult = {
  readonly outcome: Decision["outcome"];
  readonly invoice: string;
};

export async function openSend(
  ticket: string,
  invoiceId: string,
): Promise<string | null> {
  "use step";
  const { workflow } = await runs();
  const decision = await workflow.openApproval(
    ticket,
    permissions.invoice.send,
    invoices[invoiceId],
  );
  return decision.outcome === "approval-required" ? decision.token : null;
}

export async function send(
  ticket: string,
  token: string | null,
  invoiceId: string,
): Promise<SendResult> {
  "use step";
  const { workflow } = await runs();
  const row = invoices[invoiceId];
  const decision =
    token === null
      ? (await workflow.getPermDock(ticket)).decide(
          permissions.invoice.send,
          row,
        )
      : await workflow.resumeApproval(
          ticket,
          permissions.invoice.send,
          token,
          row,
        );
  return { outcome: decision.outcome, invoice: invoiceId };
}
