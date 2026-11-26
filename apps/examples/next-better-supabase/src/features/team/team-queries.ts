import "server-only";
import { postgres } from "../../lib/supabase/server.ts";

export type TeamRow = { readonly id: string; readonly name: string };

export async function teamsOf(organizationId: string): Promise<TeamRow[]> {
  const rows = await postgres.admin.queryRaw(
    `select id, name from better_supabase.teams
     where tenant_id = $1 and status = 'active'
     order by name
     limit 50`,
    [organizationId],
  );
  return rows.flatMap((row) =>
    typeof row["id"] === "string" && typeof row["name"] === "string"
      ? [{ id: row["id"], name: row["name"] }]
      : [],
  );
}
