import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { cacheLifeFor } from "permdock/next";

import type { Loaded } from "../../lib/loaded.ts";

import { timed } from "../../lib/loaded.ts";
import { staffOf } from "../../lib/store.ts";
import { getPermDock } from "../../permdock/server.ts";
import { permissions } from "../../permissions.ts";
import { orgTag } from "../organization/organization-cache.ts";
import { memberReadTags } from "./member-cache.ts";

export type StaffRow = { readonly user: string; readonly role: string };

/** Shared layer: the organization's staff. Every role change invalidates it. */
export async function getStaff(
  organization: string,
): Promise<Loaded<StaffRow[]>> {
  "use cache";
  cacheTag(orgTag(organization));
  cacheLife("max");
  const loaded = await timed(staffOf(organization));
  return loaded;
}

/**
 * The staff list this session may read: empty without `member.list`, so a
 * denied visitor never receives it in the RSC payload.
 */
export async function visibleStaff(
  organization: string,
): Promise<Loaded<StaffRow[]>> {
  "use cache: private";
  const [permdock, staff] = await Promise.all([
    getPermDock({ tenant: organization }),
    getStaff(organization),
  ]);
  cacheLife(cacheLifeFor(permdock.subject));
  cacheTag(...memberReadTags(organization, permdock.subject.principal?.id));
  return {
    ...staff,
    value: permdock.can(permissions.member.list) ? staff.value : [],
  };
}
