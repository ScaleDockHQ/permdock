import {
  getPermission,
  getPermissions,
  getSnapshot,
} from "../../permdock/server.ts";
import { permissions } from "../../policy.ts";

export async function cachedAccess(organizationId: string) {
  "use cache: private";
  const [quote, states] = await Promise.all([
    getPermission(permissions.quotes.read, undefined, {
      tenant: organizationId,
      intent: "read",
    }),
    getPermissions(
      { list: permissions.quotes.list },
      { tenant: organizationId, intent: "read" },
    ),
    getSnapshot({
      tenant: organizationId,
      tenants: "all",
      omitAssignable: true,
      context: [],
      cacheLife: { capToToken: true },
    }),
  ]);
  return { read: quote.decision.outcome, list: states.list.allowed };
}
