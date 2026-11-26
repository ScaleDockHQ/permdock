import "server-only";
import { postgres } from "../../lib/supabase/server.ts";

export type AuditRow = { readonly id: string; readonly action: string };

export async function recentAudit(organizationId: string): Promise<AuditRow[]> {
  const rows = await postgres.admin.queryRaw(
    `select id::text, op from better_supabase.audit_events
     where tenant_id = $1
     order by id desc
     limit 20`,
    [organizationId],
  );
  return rows.flatMap((row) =>
    typeof row["id"] === "string" && typeof row["op"] === "string"
      ? [{ id: row["id"], action: row["op"] }]
      : [],
  );
}
