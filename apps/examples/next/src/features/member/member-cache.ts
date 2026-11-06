import { updateTag } from "next/cache";
import { snapshotTag } from "permdock/next";

import { orgTag } from "../organization/organization-cache.ts";

/**
 * The tags of a member read that depends on the organization's rows and on the
 * subject's snapshot.
 */
export function memberReadTags(
  organization: string,
  subject: string | undefined,
): readonly [string, string] {
  return [snapshotTag(subject), orgTag(organization)];
}

/**
 * A role change: the organization's reads refresh, and so does the member's
 * snapshot.
 */
export function invalidateMember(organization: string, user: string): void {
  updateTag(orgTag(organization));
  updateTag(snapshotTag(user));
}
