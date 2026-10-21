"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { snapshotTag } from "permdock/next";
import { z } from "zod";

import type { RoleName } from "../permissions.ts";

import { orgTag } from "../lib/access.ts";
import {
  findQuote,
  removeQuote,
  setQuoteStatus,
  setStaffRole,
} from "../lib/store.ts";
import { protectAction, requirePermission } from "../permdock/server.ts";
import { permissions, roles } from "../permissions.ts";

function isRole(value: string): value is RoleName {
  return Object.hasOwn(roles, value);
}

const quoteRef = z.object({ organization: z.string(), id: z.string() });

// Resolves to { ok: false, problem } on a refusal, so the form can show it.
export const approveQuote = protectAction(permissions.quote.approve, {
  input: quoteRef,
  data: async ({ organization, id }) => {
    const quote = await findQuote(organization, id);
    return quote;
  },
  tenant: ({ organization }) => organization,
})(({ organization }, { data }) => {
  setQuoteStatus(data.id, "approved");
  updateTag(orgTag(organization));
  return data.id;
});

export async function deleteQuote(
  organization: string,
  id: string,
): Promise<void> {
  const quote = await findQuote(organization, id);
  if (quote === null) {
    return;
  }
  await requirePermission(permissions.quote.delete, quote, {
    tenant: organization,
  });
  removeQuote(quote.id);
  updateTag(orgTag(organization));
  redirect(`/${organization}/quotes`);
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function changeRole(form: FormData): Promise<void> {
  const organization = field(form, "organization");
  const user = field(form, "user");
  const role = field(form, "role");
  await requirePermission(permissions.member.manage, undefined, {
    tenant: organization,
  });
  if (!isRole(role) || role === "contact") {
    return;
  }
  if (setStaffRole(organization, user, role)) {
    updateTag(orgTag(organization));
    updateTag(snapshotTag(user));
  }
}
