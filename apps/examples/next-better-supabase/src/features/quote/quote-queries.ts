import "server-only";
import { cacheTag } from "next/cache";
import { snapshotTag } from "permdock/next";

import type { Loaded } from "../../lib/loaded.ts";

import { timed } from "../../lib/loaded.ts";
import { bsb } from "../../lib/supabase/server.ts";
import { orgTag } from "../organization/organization-cache.ts";

export type QuoteRow = {
  readonly id: string;
  readonly title: string;
  readonly amount_minor: number;
  readonly currency: string;
};

/**
 * A contact reads only their customer's quotes; the policy on `quotes` decides,
 * not this filter.
 */
export async function visibleQuotes(
  organization: string,
): Promise<Loaded<readonly QuoteRow[]>> {
  "use cache: private";
  const { sql, session } = await bsb.cached({ tags: [orgTag(organization)] });
  cacheTag(snapshotTag(session.kind === "user" ? session.user.id : null));
  const loaded = await timed(async () => {
    if (session.kind !== "user" || !sql) {
      return [];
    }
    const rows = await sql.quotes
      .list({
        where: { organization_id: organization },
        select: ["id", "title", "amount_minor", "currency"],
        orderBy: { title: "asc" },
      })
      .orThrow();
    return rows;
  });
  return loaded;
}
