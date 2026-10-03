"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { snapshotTag } from "permdock/next";

import type { RoleName } from "../permissions.ts";

import { orgTag } from "../lib/access.ts";
import {
  findQuote,
  removeQuote,
  setQuoteStatus,
  setStaffRole,
} from "../lib/store.ts";
import { requireAccess } from "../permdock/server.ts";
import { permissions, roles } from "../permissions.ts";

function isRole(value: string): value is RoleName {
  return Object.hasOwn(roles, value);
}

export async function approveQuote(
  organization: string,
  id: string,
): Promise<void> {
  const quote = await findQuote(organization, id);
  if (quote === null) {
    return;
  }
  // Denied: forbidden() or unauthorized(); the write below never runs.
  await requireAccess({
    permission: permissions.quote.approve,
    data: quote,
    tenant: organization,
  });
  setQuoteStatus(quote.id, "approved");
  updateTag(orgTag(organization));
}

export async function deleteQuote(
  organization: string,
  id: string,
): Promise<void> {
  const quote = await findQuote(organization, id);
  if (quote === null) {
    return;
  }
  await requireAccess({
    permission: permissions.quote.delete,
    data: quote,
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
  await requireAccess({
    permission: permissions.member.manage,
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
