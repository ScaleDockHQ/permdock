import "server-only";
import { approvalStore } from "../../permdock/request.ts";

export async function pendingApprovals(organizationId: string) {
  const page = await approvalStore.list({
    status: "pending",
    tenant: organizationId,
    limit: 50,
  });
  return page.items;
}
