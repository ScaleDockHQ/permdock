import "server-only";
import type { Snapshot } from "permdock";

import { getSnapshot } from "../../permdock/server.ts";
import { orgTag } from "./organization-cache.ts";

/**
 * Private layer: the session's snapshot for one organization. `getSnapshot`
 * sets `stale` from the snapshot (at least 30 s, so a per-link prefetch carries
 * it) and tags it for this subject. `omitStatic` leaves the role grants to the
 * generated bundle, which the layouts pass to the provider.
 */
export async function loadSnapshot(organization: string): Promise<Snapshot> {
  "use cache: private";
  const snapshot = await getSnapshot({
    tenant: organization,
    tags: [orgTag(organization)],
    omitStatic: true,
  });
  return snapshot;
}
