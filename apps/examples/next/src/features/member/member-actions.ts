"use server";

import type { RoleName } from "../../permissions.ts";

import { setStaffRole } from "../../lib/store.ts";
import { requirePermission } from "../../permdock/server.ts";
import { permissions, roles } from "../../permissions.ts";
import { invalidateMember } from "./member-cache.ts";

function isRole(value: string): value is RoleName {
  return Object.hasOwn(roles, value);
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
    invalidateMember(organization, user);
  }
}
