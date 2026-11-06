import { updateTag } from "next/cache";
import { snapshotTag } from "permdock/next";

import { orgTag } from "../organization/organization-cache.ts";

/**
 * The tags of a quote read that depends on the organization's rows and on the
 * subject's snapshot.
 */
export function quoteReadTags(
  organization: string,
  subject: string | undefined,
): readonly [string, string] {
  return [snapshotTag(subject), orgTag(organization)];
}

/** A write to the organization's quotes: every read tagged with it refreshes. */
export function invalidateQuotes(organization: string): void {
  updateTag(orgTag(organization));
}
