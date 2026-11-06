import "server-only";
import type { Snapshot } from "permdock";

import { cacheLife, cacheTag } from "next/cache";
import { emptySnapshot } from "permdock";

import { brandGuard } from "../../lib/brand-guard.ts";
import { latency } from "../../lib/latency.ts";
import { postgres } from "../../lib/supabase/server.ts";
import { getSnapshot } from "../../permdock/server.ts";
import { orgSlugTag, orgTag } from "./organization-cache.ts";

export type Organization = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
};

/**
 * Shared layer: slugs are public, so the lookup reads no session and every
 * visitor shares it. Nothing writes organizations at run time, so the entry
 * lives until its tag is invalidated.
 */
export async function organizationBySlug(
  slug: string,
): Promise<Organization | null> {
  "use cache";
  cacheTag(orgSlugTag(slug));
  cacheLife("max");
  await latency();
  const rows = await postgres.anon.queryRaw<Organization>(
    "select id, slug, name from public.organizations where slug = $1",
    [slug],
  );
  return rows[0] ?? null;
}

/**
 * Private layer: the session's snapshot for one organization. `getSnapshot`
 * sets `stale` from the snapshot and tags it `snapshotTag(sub)`; the subject's
 * `bsb.cached()` caps `stale` at the token's expiry and at 300 s. The snapshot
 * is keyed on the organization, so a per-link prefetch carries it.
 */
export async function loadSnapshot(organization: string): Promise<Snapshot> {
  "use cache: private";
  await latency();
  const snapshot = await getSnapshot({
    tenant: organization,
    tags: [orgTag(organization)],
  });
  return snapshot;
}

/**
 * The layout's snapshot: an unknown slug gets the empty one, and the page
 * answers 404.
 */
export async function snapshotForSlug(slug: string): Promise<Snapshot> {
  if (brandGuard(slug) === null) {
    return emptySnapshot();
  }
  const organization = await organizationBySlug(slug);
  return organization === null
    ? emptySnapshot()
    : loadSnapshot(organization.id);
}
