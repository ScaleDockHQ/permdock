"use server";

import { updateTag } from "next/cache";
import { z } from "zod";

import { protectAction } from "../../permdock/server.ts";
import { permissions } from "../../policy.ts";
import { orgTag } from "../organization/organization-cache.ts";
import { visibleQuotes } from "./quote-queries.ts";
import {
  insertQuote,
  patchQuote,
  quoteById,
  removeQuote,
} from "./quote-store.ts";

const quoteId = z.uuid();

const located = z.object({ organizationId: z.uuid(), id: quoteId });

export const listQuotes = protectAction(permissions.quotes.list, {
  input: z.object({ organizationId: z.uuid() }),
  tenant: (input) => input.organizationId,
})(async (input) => {
  const loaded = await visibleQuotes(input.organizationId);
  return { count: loaded.value.length };
});

export const createQuote = protectAction(permissions.quotes.create, {
  input: z.object({
    organizationId: z.uuid(),
    customerId: z.uuid(),
    title: z.string().min(1),
    amountMinor: z.number().int().nonnegative(),
    currency: z.string().length(3),
  }),
  tenant: (input) => input.organizationId,
})(async (input) => {
  const id = await insertQuote(input);
  return { id };
});

export const renameQuote = protectAction(permissions.quotes.update, {
  args: [quoteId],
  input: z.object({ title: z.string().min(1), organizationId: z.uuid() }),
  data: async (_input, [id]) => {
    const quote = await quoteById(id);
    return quote;
  },
  tenant: (input) => input.organizationId,
})(
  async (input, context) => {
    await patchQuote(context.args[0], { title: input.title });
    return { title: input.title };
  },
  {
    after(_decision, context) {
      updateTag(orgTag(context.data.organization_id));
    },
    result: (value) => ({ renamed: value.title }),
  },
);

export const sendQuote = protectAction(permissions.quotes.send, {
  input: located,
  data: async (input) => {
    const quote = await quoteById(input.id);
    return quote;
  },
  tenant: (input) => input.organizationId,
})(async (input) => {
  await patchQuote(input.id, { status: "sent" });
  return { id: input.id, status: "sent" as const };
});

export const approveQuote = protectAction(permissions.quotes.approve, {
  input: located,
  data: async (input) => {
    const quote = await quoteById(input.id);
    return quote;
  },
  tenant: (input) => input.organizationId,
})(async (input) => {
  await patchQuote(input.id, { status: "approved" });
  return { id: input.id, status: "approved" as const };
});

export const deleteQuote = protectAction(permissions.quotes.delete, {
  input: located,
  data: async (input) => {
    const quote = await quoteById(input.id);
    return quote;
  },
  tenant: (input) => input.organizationId,
})(async (input) => {
  await removeQuote(input.id);
  return { id: input.id };
});
