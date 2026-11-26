import "server-only";
import {
  createApprovals,
  sqlTransport,
} from "better-supabase/blocks/approvals";

import { postgres } from "../../lib/supabase/server.ts";

/** Pending requests in one organization. The block client needs that tenant. */
export async function pendingApprovals(organizationId: string) {
  const listed = await createApprovals({
    transport: sqlTransport(postgres.admin),
    tenant: organizationId,
  }).list({ status: "pending", pageSize: 50 });
  if (!listed.ok) {
    throw new Error("PermDock: the approvals block's list failed", {
      cause: listed.error,
    });
  }
  return listed.data.map((item) => ({ id: item.id, status: item.status }));
}
