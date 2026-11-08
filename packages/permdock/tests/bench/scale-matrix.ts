import { z } from "zod";

import type { CustomRole } from "../../src/index.ts";

import {
  allow,
  definePermissions,
  definePolicy,
  memoryCustomRoleSource,
  principal,
  resource,
  role,
} from "../../src/index.ts";

/** Membership, role and custom-role tiers of the scale audit. */
export const MEMBERSHIP_TIERS = [1, 12, 150, 500] as const;
export const ROLE_TIERS = [1, 5, 20] as const;
export const CUSTOM_ROLE_TIERS = [0, 50, 500] as const;
export const TOOL_COUNT = 300;
export const FILTER_ROWS = 100_000;
export const DECIDE_IDS = 1_000;
/** Grants per custom role; 500 roles × 500 tenants × 16 is the 4M-row table. */
const GRANTS_PER_CUSTOM_ROLE = 16;

const Item = z.object({
  id: z.string(),
  orgId: z.string(),
  ownerId: z.string(),
});

const tools = Object.fromEntries(
  Array.from({ length: TOOL_COUNT }, (_, index) => [
    `tool${String(index)}`,
    resource({ collection: ["invoke"] }),
  ]),
);

export const permissions = definePermissions({
  item: resource(Item, {
    id: "id",
    actions: ["read", "update"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
  ...tools,
});

type ToolName = `tool${string}`;

function toolPermission(index: number) {
  const name: ToolName = `tool${String(index)}`;
  // SAFETY: `tools` registers exactly `tool0` to `tool299`.
  const tool = (
    permissions as unknown as Record<ToolName, { invoke: never } | undefined>
  )[name];
  if (tool === undefined) throw new Error(`missing ${name}`);
  return tool.invoke;
}

function roleName(index: number): string {
  return `r${String(index)}`;
}

const declared = Array.from(
  { length: Math.max(...ROLE_TIERS) },
  (_item, index) =>
    role(
      roleName(index),
      [
        allow(permissions.item.read),
        allow(permissions.item.update, { where: { ownerId: principal.id } }),
        // 15 tools per declared role, so a 20-role subject reaches all 300.
        ...Array.from({ length: TOOL_COUNT / 20 }, (_tool, tool) =>
          allow(toolPermission(index * (TOOL_COUNT / 20) + tool)),
        ),
      ],
      { on: "tenant", assignable: true },
    ),
);

export type ScaleUser = {
  readonly id: string;
  readonly memberships: readonly {
    readonly scope: string;
    readonly id: string;
    readonly roles: readonly string[];
  }[];
};

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  subject: (user: ScaleUser | null) => user,
  roles: declared,
});

export function tenantId(index: number): string {
  return `t${String(index).padStart(4, "0")}`;
}

function customRoleName(index: number): string {
  return `c${String(index)}`;
}

/**
 * `customRoles` roles per tenant, each granting `GRANTS_PER_CUSTOM_ROLE` tool
 * permissions the declared roles also reach, so every grant exercises the
 * ceiling check.
 */
export function customRolesFor(
  tenants: number,
  customRoles: number,
): readonly CustomRole[] {
  const roles: CustomRole[] = [];
  for (let tenant = 0; tenant < tenants; tenant += 1) {
    for (let index = 0; index < customRoles; index += 1) {
      roles.push({
        name: customRoleName(index),
        tenant: tenantId(tenant),
        grants: Array.from(
          { length: GRANTS_PER_CUSTOM_ROLE },
          (_grant, grant) => ({
            permission: `tool${String(
              (index * GRANTS_PER_CUSTOM_ROLE + grant) % TOOL_COUNT,
            )}.invoke`,
          }),
        ),
      });
    }
  }
  return roles;
}

/**
 * A user with `memberships` tenant memberships of `roles` roles each. When the
 * tier has custom roles, one role per membership is a custom role.
 */
export function userFor(
  memberships: number,
  roles: number,
  customRoles: number,
): ScaleUser {
  return {
    id: "u-scale",
    memberships: Array.from({ length: memberships }, (_member, tenant) => ({
      scope: "tenant",
      id: tenantId(tenant),
      roles: Array.from({ length: roles }, (_role, index) =>
        customRoles > 0 && index === 0
          ? customRoleName(tenant % customRoles)
          : roleName(index),
      ),
    })),
  };
}

export function sourceFor(
  memberships: number,
  customRoles: number,
): ReturnType<typeof memoryCustomRoleSource> {
  return memoryCustomRoleSource(customRolesFor(memberships, customRoles));
}

export function rowsFor(
  count: number,
  tenant: string,
): readonly { id: string; orgId: string; ownerId: string }[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `i${String(index)}`,
    orgId: index % 2 === 0 ? tenant : tenantId(index % 7),
    ownerId: index % 3 === 0 ? "u-scale" : "someone",
  }));
}

export function toolPermissions(): readonly ReturnType<
  typeof toolPermission
>[] {
  return Array.from({ length: TOOL_COUNT }, (_, index) =>
    toolPermission(index),
  );
}
