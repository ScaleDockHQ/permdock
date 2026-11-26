import "server-only";
import type { CustomRole, CustomRoleSource, EntitlementSource } from "permdock";

import {
  createApprovals,
  sqlTransport,
} from "better-supabase/blocks/approvals";
import { headers } from "next/headers";
import {
  blockApprovalPolicySource,
  blockApprovalStore,
} from "permdock/better-supabase";
import { tenantFromPath } from "permdock/next";

import { postgres } from "../lib/supabase/server.ts";

/** The proxy sets this to the organization slug on the request path. */
export const orgHeader = "x-permdock-org";

async function organizationId(slug: string): Promise<string | undefined> {
  const rows = await postgres.admin.queryRaw(
    "select id from public.organizations where slug = $1",
    [slug],
  );
  const id = rows[0]?.["id"];
  return typeof id === "string" ? id : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : [];
}

/** Resolves `[orgSlug]` for a route handler that has `params`. */
export const orgTenant = tenantFromPath({
  param: "orgSlug",
  resolve: organizationId,
});

/** The factory tenant: the slug the proxy stored, else no tenant. */
export async function tenantOfRequest(): Promise<string | undefined> {
  const slug = (await headers()).get(orgHeader);
  return slug === null || slug.length === 0 ? undefined : organizationId(slug);
}

/**
 * Compiled custom roles. An empty table answers none, so a held name grants
 * nothing.
 */
export const compiledRoles: CustomRoleSource = {
  name: "compiled",
  async rolesFor(tenant): Promise<CustomRole[]> {
    const rows = await postgres.admin.queryRaw(
      `select role, scope, scope_id, grant_keys, includes
       from permdock.custom_role_compiled
       where tenant_id = $1::uuid`,
      [tenant],
    );
    return rows.flatMap((row): CustomRole[] => {
      if (typeof row["role"] !== "string") {
        return [];
      }
      const scope = typeof row["scope"] === "string" ? row["scope"] : undefined;
      const id =
        typeof row["scope_id"] === "string" ? row["scope_id"] : undefined;
      return [
        {
          name: row["role"],
          tenant,
          ...(scope === undefined ? {} : { scope }),
          ...(id === undefined ? {} : { id }),
          grants: strings(row["grant_keys"]).map((permission) => ({
            permission,
          })),
          includes: strings(row["includes"]),
        },
      ];
    });
  },
};

/**
 * Active Stripe lookup keys for the tenant. Empty until the sync engine is
 * installed.
 */
export const stripeEntitlements: EntitlementSource = {
  name: "stripe",
  async entitlementsFor(_principal, options) {
    if (options.tenant === undefined) {
      return [];
    }
    const rows = await postgres.admin.queryRaw(
      "select better_supabase.tenant_entitlements($1::uuid) as keys",
      [options.tenant],
    );
    return strings(rows[0]?.["keys"]);
  },
};

const approvals = createApprovals({ transport: sqlTransport(postgres.admin) });

/**
 * Files `approval-required` decisions on the approvals block, as the service
 * role.
 */
export const approvalStore = blockApprovalStore(approvals);

/** Tenant and platform approval policies from the approvals block. */
export const approvalPolicySource = blockApprovalPolicySource(approvals, {
  platform: true,
});
