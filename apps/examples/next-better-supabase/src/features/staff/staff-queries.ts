import "server-only";
import { cacheTag } from "next/cache";
import { snapshotTag } from "permdock/next";

import type { Loaded } from "../../lib/loaded.ts";

import { timed } from "../../lib/loaded.ts";
import { bsb } from "../../lib/supabase/server.ts";
import { orgTag } from "../organization/organization-cache.ts";

export type StaffRow = {
  readonly id: string;
  readonly name: string;
  readonly title: string;
};

/**
 * Read through RLS as the caller: `permitted_organization_ids('staff.list')`
 * filters the rows.
 */
export async function visibleStaff(
  organization: string,
): Promise<Loaded<readonly StaffRow[]>> {
  "use cache: private";
  const { sql, session } = await bsb.cached({ tags: [orgTag(organization)] });
  cacheTag(snapshotTag(session.kind === "user" ? session.user.id : null));
  const loaded = await timed(async () => {
    if (session.kind !== "user" || !sql) {
      return [];
    }
    const rows = await sql.staff
      .list({
        where: { organization_id: organization },
        select: ["id", "name", "title"],
        orderBy: { name: "asc" },
      })
      .orThrow();
    return rows;
  });
  return loaded;
}
