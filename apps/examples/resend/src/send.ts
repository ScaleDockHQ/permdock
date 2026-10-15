import type { EmailTransport, Recipient } from "permdock/delivery";

import { createPermDock, memoryDecisionSink, whoCan } from "permdock";
import { memoryApprovalStore, requestApproval } from "permdock/approvals";
import {
  approvalPrompt,
  audience,
  createPermDock as createDelivery,
  memoryDeliveryTransport,
} from "permdock/delivery";
import { approvalEmail, resendTransport } from "permdock/resend";
import { Resend } from "resend";

import { invoice, permissions } from "./permissions.ts";
import { emails, memberships, policy, principals, userById } from "./policy.ts";

const FROM = "Acme Billing <billing@acme.test>";
const APPROVALS = "https://app.acme.test/approvals";

function emailTransport(): EmailTransport {
  const key = process.env["RESEND_API_KEY"] ?? "";
  if (key === "") {
    return memoryDeliveryTransport("email");
  }
  return resendTransport(new Resend(key), { from: FROM });
}

const sink = memoryDecisionSink();
const delivery = createDelivery(policy, {
  transports: { email: emailTransport() },
  principals,
  sink,
  from: FROM,
});

function toRecipient(principal: string): Recipient {
  return { principal, channel: "email", address: emails[principal] ?? "" };
}

const sender = await createPermDock(policy, userById("u_billing"), {
  memberships,
  principals,
});

const notice = await delivery.deliver(
  sender,
  permissions.invoice.read,
  invoice,
  [
    toRecipient("u_member"),
    { channel: "email", address: "cleo@client.test" },
    { channel: "email", address: "someone@elsewhere.test" },
  ],
  {
    email: {
      subject: `Invoice ${invoice.id} is ready`,
      text: `Invoice ${invoice.id} is ready. View it at https://app.acme.test/invoices/${invoice.id}.`,
      category: "notification",
      unsubscribe: { url: "https://app.acme.test/unsubscribe?list=invoices" },
    },
  },
);

const store = memoryApprovalStore();
const decision = sender.decide(permissions.invoice.pay, invoice);
if (decision.outcome !== "approval-required") {
  throw new Error(`Expected approval-required, got ${decision.outcome}`);
}
const request = await requestApproval(store, decision, {
  permission: permissions.invoice.pay,
  resource: { type: "invoice", id: invoice.id },
  subject: sender.subject,
  detail: `Pay invoice ${invoice.id}`,
});
const holders = await whoCan(sender, permissions.invoice.pay, invoice);
const approvers = await audience(sender, permissions.invoice.read, invoice, {
  candidates: holders.holders
    .map((holder) => holder.principal.id)
    .filter((id) => id !== sender.subject.principal?.id),
});
const prompt = approvalPrompt(request);
const approval = await delivery.deliver(
  sender,
  permissions.invoice.read,
  invoice,
  approvers.principals.map(toRecipient),
  { email: approvalEmail(prompt, { approvalUrl: APPROVALS }) },
  { approval: prompt.id },
);

for (const report of [notice, approval]) {
  process.stdout.write(
    `${report.id}: ${report.sent} sent, ${report.failed} failed\n`,
  );
}
for (const event of sink.events()) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
