import { bsb } from "../../../lib/supabase/server.ts";
import { permissions } from "../../../policy.ts";

/**
 * The authorizer decides `staff.list` in the caller's active tenant before the
 * query runs; RLS then filters the rows.
 */
export const GET = bsb.route(
  async (_request, { db }) => {
    const staff = await db.staff
      .list({ select: ["id", "name", "title"], orderBy: { name: "asc" } })
      .orThrow();
    return Response.json(staff);
  },
  { requireTenant: true, permission: permissions.staff.list },
);
