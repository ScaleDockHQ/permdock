import "server-only";
import { postgres } from "../../lib/supabase/server.ts";

export type MemberRow = { readonly userId: string; readonly role: string };

export async function membersOf(organizationId: string): Promise<MemberRow[]> {
  const rows = await postgres.admin.queryRaw(
    `select user_id, role from public.organization_memberships
     where organization_id = $1
     order by role, user_id
     limit 50`,
    [organizationId],
  );
  return rows.flatMap((row) =>
    typeof row["user_id"] === "string" && typeof row["role"] === "string"
      ? [{ userId: row["user_id"], role: row["role"] }]
      : [],
  );
}
